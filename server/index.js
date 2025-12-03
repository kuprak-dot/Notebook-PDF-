const express = require('express');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Store processed data in memory
let processedFiles = {};

const { syncDriveFiles } = require('./driveSync');

// ... (existing imports)

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'API_KEY_MISSING');
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API to get processed files
app.get('/api/results', (req, res) => {
    res.json(Object.values(processedFiles));
});

// Function to process PDF
async function processPDF(filePath) {
    const fileName = path.basename(filePath);
    console.log(`Processing ${fileName}...`);

    try {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdf(dataBuffer);
        const text = data.text;

        // Analyze with Gemini
        let analysis = "Analysis pending or failed.";
        if (process.env.GEMINI_API_KEY) {
            try {
                const prompt = `
Analyze the following text from a notebook or document PDF. Provide a comprehensive and detailed analysis.

**Output Structure:**

1.  **Executive Summary**: A concise paragraph summarizing the main topic and purpose of the document.
2.  **Detailed Key Points**: A bulleted list of the most important information, facts, or arguments presented. Be specific.
3.  **Action Items & Deadlines**: Extract any tasks, calls to action, or specific dates/deadlines mentioned. If none, state "None identified."
4.  **Technical/Medical Terminology**: If the text contains specialized terms (medical, legal, technical), list and briefly define them based on context.
5.  **Unresolved Questions**: Identify any questions raised in the text that remain unanswered or require follow-up.

**Text Content:**
${text.substring(0, 20000)}
`; // Increased limit for better context
                const result = await model.generateContent(prompt);
                const response = await result.response;
                analysis = response.text();
            } catch (aiError) {
                console.error("AI Error:", aiError);
                analysis = `Error generating AI analysis: ${aiError.message}`;
            }
        } else {
            analysis = "API Key missing. Please add GEMINI_API_KEY to .env file.";
        }

        processedFiles[fileName] = {
            name: fileName,
            timestamp: new Date(),
            textPreview: text.substring(0, 200) + "...",
            analysis: analysis
        };
        console.log(`Finished processing ${fileName}`);

    } catch (err) {
        console.error(`Error processing ${fileName}:`, err);
    }
}

// Initialize Watcher (only in local development, not in Vercel)
if (process.env.NODE_ENV !== 'production') {
    const dataDir = path.join(__dirname, '../data');
    const watcher = chokidar.watch(dataDir, {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true
    });

    watcher
        .on('add', filePath => {
            console.log(`File added: ${filePath}`);
            processPDF(filePath);
        })
        .on('change', filePath => {
            console.log(`File changed: ${filePath}`);
            processPDF(filePath);
        })
        .on('error', error => console.log(`Watcher error: ${error}`));

    // Process existing files on startup
    fs.readdir(dataDir, (err, files) => {
        if (err) {
            console.error("Error reading data directory:", err);
            return;
        }
        files.forEach(file => {
            if (file.toLowerCase().endsWith('.pdf')) {
                processPDF(path.join(dataDir, file));
            }
        });
    });
}

// Initialize Drive Sync on startup (works in both local and Vercel)
const driveFolderId = process.env.DRIVE_FOLDER_ID;
if (driveFolderId) {
    console.log(`Starting Drive Sync for folder: ${driveFolderId}`);
    const dataDir = path.join(__dirname, '../data');

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initial sync
    syncDriveFiles(driveFolderId, dataDir);

    // Poll every 5 minutes (only in local dev, Vercel will re-sync on each cold start)
    if (process.env.NODE_ENV !== 'production') {
        setInterval(() => {
            syncDriveFiles(driveFolderId, dataDir);
        }, 5 * 60 * 1000);
    }
} else {
    console.log("Drive Sync skipped: DRIVE_FOLDER_ID not set");
}

// For local development
if (process.env.NODE_ENV !== 'production') {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}

// Export for Vercel
module.exports = app;
