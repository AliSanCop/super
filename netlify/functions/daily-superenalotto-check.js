// netlify/functions/daily-superenalotto-check.js
const axios = require("axios");
const cheerio = require("cheerio");
const { createClient } = require("@supabase/supabase-js"); // Import Supabase

// --- Supabase Client Initialization ---
// Get Supabase credentials from environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use service_role key for backend

// Ensure Supabase credentials are provided
if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Error: SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required."
  );
  // Optionally handle this more gracefully, maybe preventing the function from running fully.
}

// Create a single Supabase client instance
const supabase = createClient(supabaseUrl, supabaseKey);
// --- End Supabase Client Initialization ---

// --- Persistence Layer using Supabase ---
const STATE_TABLE = "app_state"; // Name of your table in Supabase
const LAST_DATE_KEY = "last_processed_date"; // The key for the date value

async function getLastProcessedDate() {
  if (!supabaseUrl || !supabaseKey) return null; // Don't proceed without credentials

  console.log(`Querying Supabase for key: ${LAST_DATE_KEY}`);
  try {
    const { data, error } = await supabase
      .from(STATE_TABLE)
      .select("value") // Select only the 'value' column
      .eq("key", LAST_DATE_KEY) // Where the 'key' matches
      .single(); // Expect only one row (or null)

    if (error && error.code !== "PGRST116") {
      // PGRST116: "The result contains 0 rows" - ignore this specific error
      console.error(
        "Error fetching last processed date from Supabase:",
        error.message
      );
      throw error; // Re-throw other errors
    }

    if (data) {
      console.log(`Found last processed date in Supabase: ${data.value}`);
      return data.value; // Return the stored date string
    } else {
      console.log(
        `No record found for key ${LAST_DATE_KEY} in Supabase. First run?`
      );
      return null; // No date found yet
    }
  } catch (err) {
    console.error("Supabase query failed:", err);
    // Depending on requirements, you might return null or throw to stop execution
    return null;
  }
}

async function setLastProcessedDate(date) {
  if (!supabaseUrl || !supabaseKey) return; // Don't proceed without credentials

  console.log(`Upserting Supabase key: ${LAST_DATE_KEY} with value: ${date}`);
  try {
    const { data, error } = await supabase.from(STATE_TABLE).upsert(
      { key: LAST_DATE_KEY, value: date }, // Data to insert or update
      { onConflict: "key" } // Specify the conflict target (the 'key' column)
    );

    if (error) {
      console.error(
        "Error setting last processed date in Supabase:",
        error.message
      );
      throw error; // Re-throw errors
    }

    console.log("Successfully updated last processed date in Supabase.");
    // console.log('Supabase upsert result:', data); // Optional: log result details
  } catch (err) {
    console.error("Supabase upsert failed:", err);
    // Handle error (e.g., maybe send an error notification)
  }
}
// --- End Persistence Layer ---

// --- Notification Logic --- (Keep your existing sendNotification function) ---
async function sendNotification(title, message) {
  const ntfyTopic = process.env.NTFY_TOPIC;
  if (!ntfyTopic) {
    console.error("Error: NTFY_TOPIC environment variable not set.");
    return;
  }
  const ntfyUrl = `https://ntfy.sh/${ntfyTopic}`;
  try {
    await axios.post(ntfyUrl, message, {
      headers: { Title: title, "Content-Type": "text/plain" },
    });
    console.log(`Notification sent to ${ntfyUrl}`);
  } catch (error) {
    console.error(
      `Error sending notification to ${ntfyUrl}:`,
      error.response?.data || error.message
    );
  }
}
// --- End Notification Logic ---

// --- Scraping Logic --- (Keep your existing scrapeSuperEnalotto function) ---
async function scrapeSuperEnalotto() {
  const url = "https://www.superenalotto.it/archivio-estrazioni";
  console.log(`Workspaceing data from ${url}`);
  try {
    // Add a User-Agent to be polite
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36", // Optional: Be identifiable
      },
    });
    const $ = cheerio.load(html);

    // *** VERIFY AND ADJUST SELECTORS ***
    const results = [];
    const tableBody = $("section#archivioEstrazioni table tbody"); // Example selector
    if (!tableBody.length) {
      console.error(
        "Could not find the results table body. Site structure might have changed."
      );
      // Send an error notification maybe?
      await sendNotification(
        "SuperEnalotto Scraper Error",
        "Failed to find results table body. Selectors might need updating."
      );
      return null;
    }

    tableBody.find("tr").each((index, element) => {
      const row = $(element);
      // *** VERIFY AND ADJUST SELECTORS FOR DATE AND NUMBERS ***
      const dateStr = row.find("td").eq(0).text().trim(); // Adjust index/selector
      const numbers = new Set();
      let numbersFound = 0;

      // Example: Numbers in spans within the second td
      row
        .find("td")
        .eq(1)
        .find("span.numero")
        .each((i, numEl) => {
          // Adjust selectors
          if (numbersFound < 6) {
            const num = parseInt($(numEl).text().trim(), 10);
            if (!isNaN(num)) {
              numbers.add(num);
              numbersFound++;
            }
          }
        });

      // Example: Jolly in the third td span.numero-jolly
      if (numbersFound === 6) {
        const jollyEl = row.find("td").eq(2).find("span.numero-jolly"); // Adjust selectors
        const jollyNum = parseInt(jollyEl.text().trim(), 10);
        if (!isNaN(jollyNum)) {
          numbers.add(jollyNum);
          numbersFound++;
        }
      }

      // Robust date parsing (adjust regex/logic based on actual format)
      const parts = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/); // Assumes DD/MM/YYYY
      let formattedDate = null;
      if (parts) {
        formattedDate = `${parts[3]}-${parts[2]}-${parts[1]}`; // To YYYY-MM-DD
      } else {
        console.warn(`Could not parse date: ${dateStr} on row ${index + 1}`);
      }

      if (formattedDate && numbers.size === 7) {
        results.push({ date: formattedDate, numbers: numbers });
      } else {
        console.warn(
          `Skipping row ${
            index + 1
          }: Invalid data (Date: ${dateStr}, Numbers found: ${numbers.size})`
        );
      }
    });

    results.sort((a, b) => b.date.localeCompare(a.date)); // Sort descending by date
    console.log(`Scraped ${results.length} valid entries.`);
    return results;
  } catch (error) {
    console.error("Error during scraping:", error.message);
    await sendNotification(
      "SuperEnalotto Scraper Error",
      `Failed to scrape data: ${error.message}`
    );
    return null;
  }
}
// --- End Scraping Logic ---

// --- Main Handler --- (Logic remains the same, uses new persistence functions) ---
exports.handler = async (event, context) => {
  console.log("Scheduled function triggered.");

  // Ensure Supabase client is available before proceeding
  if (!supabaseUrl || !supabaseKey) {
    console.error("Supabase credentials missing. Exiting function.");
    return {
      statusCode: 500,
      body: "Configuration error: Supabase credentials missing.",
    };
  }

  const scrapedResults = await scrapeSuperEnalotto();

  if (!scrapedResults || scrapedResults.length === 0) {
    console.log("No results scraped or scraping failed. Exiting.");
    // Keep status 200 if scraping failed gracefully (e.g. site changed, error logged/notified)
    // Change to 500 if it was an unexpected crash
    return { statusCode: 200, body: "Scraping failed or yielded no results." };
  }

  const latestScrapedEntry = scrapedResults[0];
  const latestScrapedDate = latestScrapedEntry.date;

  const lastProcessedDate = await getLastProcessedDate(); // Uses Supabase now

  console.log(`Latest scraped date: ${latestScrapedDate}`);
  console.log(`Last processed date from DB: ${lastProcessedDate || "None"}`);

  if (!lastProcessedDate || latestScrapedDate > lastProcessedDate) {
    console.log(`New extraction found for date: ${latestScrapedDate}`);

    const numbersArray = Array.from(latestScrapedEntry.numbers).sort(
      (a, b) => a - b
    );
    const numbersString = numbersArray.join(", ");

    await sendNotification(
      `New SuperEnalotto Extraction (${latestScrapedDate})`,
      `Numbers: ${numbersString}`
    );

    // Update the database with the new latest date
    await setLastProcessedDate(latestScrapedDate); // Uses Supabase now

    return {
      statusCode: 200,
      body: `New extraction found for ${latestScrapedDate} and notification sent.`,
    };
  } else {
    console.log("No new extractions found since last run.");
    return {
      statusCode: 200,
      body: "No new extractions found.",
    };
  }
};
// --- End Main Handler ---
