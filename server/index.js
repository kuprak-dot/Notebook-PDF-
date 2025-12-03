const express = require('express');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cheerio = require('cheerio');
const axios = require('axios');
require('dotenv').config();

// Only import chokidar in non-production (local dev)
let chokidar;
if (process.env.NODE_ENV !== 'production') {
    chokidar = require('chokidar');
}

const app = express();
const port = process.env.PORT || 3000;

// Define Data Directory based on environment
const DATA_DIR = process.env.NODE_ENV === 'production'
    ? path.join('/tmp', 'data')
    : path.join(__dirname, '../data');

// Ensure data directory exists immediately
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Store processed data in memory
let processedFiles = {};
let driveSyncInitialized = false; // Flag to track sync status

const { syncDriveFiles, uploadSummaryToDrive, uploadFileToDrive, deleteFileFromDrive } = require('./driveSync');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'API_KEY_MISSING');
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Middleware to initialize Drive Sync on first request (for Vercel)
// Placed BEFORE API routes to ensure data is ready
app.use(async (req, res, next) => {
    // Skip for static files if possible, but express.static handles those above.
    // This will mostly catch API requests.
    if (!driveSyncInitialized) {
        await initializeDriveSync();
    }
    next();
});

// API to get processed files
app.get('/api/results', (req, res) => {
    res.json(Object.values(processedFiles));
});

// API to delete a processed file
app.delete('/api/results/:filename', async (req, res) => {
    const filename = req.params.filename;

    try {
        // 1. Remove from memory
        if (processedFiles[filename]) {
            delete processedFiles[filename];
        }

        // 2. Remove local files
        const pdfPath = path.join(DATA_DIR, filename);
        const jsonPath = path.join(DATA_DIR, `${filename}.json`);

        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

        // 3. Remove from Drive (both PDF and JSON analysis)
        const driveFolderId = process.env.DRIVE_FOLDER_ID;
        if (driveFolderId) {
            await deleteFileFromDrive(driveFolderId, filename, log);
            await deleteFileFromDrive(driveFolderId, `${filename}.json`, log);
        }

        log(`Deleted ${filename} and its analysis.`);
        res.json({ success: true, message: `${filename} deleted` });
    } catch (error) {
        console.error(`Error deleting ${filename}:`, error);
        res.status(500).json({ success: false, message: 'Error deleting file: ' + error.message });
    }
});

// Log capturing
let serverLogs = [];
function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    serverLogs.push(logMessage);
    // Keep only last 100 logs
    if (serverLogs.length > 100) {
        serverLogs.shift();
    }
}

// Debug Endpoint
app.get('/api/debug', async (req, res) => {
    // Force Sync Option
    if (req.query.forceSync === 'true') {
        log("Force Sync requested via Debug API");
        await initializeDriveSync();
    }

    let filesInDataDir = [];
    try {
        if (fs.existsSync(DATA_DIR)) {
            filesInDataDir = fs.readdirSync(DATA_DIR);
        } else {
            filesInDataDir = ['DATA_DIR does not exist'];
        }
    } catch (e) {
        filesInDataDir = ['Error reading DATA_DIR: ' + e.message];
    }

    let credentialsStatus = 'Missing';
    let credentialsError = null;
    let clientEmail = 'Unknown';

    if (process.env.GOOGLE_CREDENTIALS_JSON) {
        try {
            const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
            clientEmail = creds.client_email;
            credentialsStatus = 'Valid JSON';
        } catch (e) {
            credentialsStatus = 'Invalid JSON';
            credentialsError = e.message;
        }
    }

    res.json({
        nodeEnv: process.env.NODE_ENV,
        dataDir: DATA_DIR,
        filesInDataDir: filesInDataDir,
        processedFilesCount: Object.keys(processedFiles).length,
        processedFileNames: Object.keys(processedFiles),
        driveSyncInitialized: driveSyncInitialized,
        envVars: {
            GEMINI_API_KEY: !!process.env.GEMINI_API_KEY ? 'Present' : 'Missing',
            DRIVE_FOLDER_ID: process.env.DRIVE_FOLDER_ID || 'Missing',
            GOOGLE_CREDENTIALS_JSON: credentialsStatus,
            clientEmail: clientEmail,
            credentialsError: credentialsError
        },
        logs: serverLogs
    });
});

// API to process a URL
app.post('/api/process-url', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ success: false, message: 'URL is required' });
    }

    try {
        await processURL(url);
        res.json({ success: true, message: 'URL processed successfully' });
    } catch (error) {
        console.error('Error processing URL:', error);
        res.status(500).json({ success: false, message: 'Error processing URL: ' + error.message });
    }
});

// API to save analysis to Google Drive
app.post('/api/save-to-drive', async (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        return res.status(400).json({ success: false, message: 'Filename is required' });
    }

    const fileData = processedFiles[filename];
    if (!fileData) {
        return res.status(404).json({ success: false, message: 'File not found in processed files' });
    }

    const driveFolderId = process.env.DRIVE_FOLDER_ID;
    if (!driveFolderId) {
        return res.status(500).json({ success: false, message: 'Drive folder ID not configured' });
    }

    try {
        const result = await uploadSummaryToDrive(driveFolderId, filename, fileData.analysis, log);
        res.json({
            success: true,
            message: 'Summary saved to Google Drive successfully',
            driveFile: result
        });
    } catch (error) {
        console.error('Error saving to Drive:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving to Drive: ' + error.message
        });
    }
});

// Function to process PDF
async function processPDF(filePath) {
    const fileName = path.basename(filePath);
    const jsonPath = filePath + '.json'; // e.g. document.pdf.json

    // 1. Check for local JSON cache (Persistence Layer)
    if (fs.existsSync(jsonPath)) {
        try {
            const cachedData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            processedFiles[fileName] = cachedData;
            log(`Loaded analysis from cache for ${fileName}`);
            return;
        } catch (err) {
            console.error(`Error reading cache for ${fileName}, re-processing:`, err);
        }
    }

    log(`Processing ${fileName}...`);

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

        const resultData = {
            name: fileName,
            timestamp: new Date(),
            textPreview: text.substring(0, 200) + "...",
            analysis: analysis
        };

        processedFiles[fileName] = resultData;

        // 2. Save to local JSON cache
        fs.writeFileSync(jsonPath, JSON.stringify(resultData, null, 2));

        // 3. Upload JSON cache to Drive (Persistence)
        if (process.env.DRIVE_FOLDER_ID) {
            // We upload it as a hidden/system file effectively by naming it .json
            // This ensures that if the server restarts, we can download this JSON and skip re-processing.
            try {
                await uploadFileToDrive(process.env.DRIVE_FOLDER_ID, jsonPath, 'application/json', log);
            } catch (uploadErr) {
                console.error(`Error uploading cache for ${fileName}:`, uploadErr);
            }
        }

        log(`Finished processing ${fileName}`);

    } catch (err) {
        console.error(`Error processing ${fileName}:`, err);
    }
}

// Function to process URL
async function processURL(url) {
    log(`Processing URL: ${url}...`);
    const fileName = url; // Use URL as the key/filename

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const html = response.data;
        const $ = cheerio.load(html);

        // Remove scripts, styles, and other non-content elements
        $('script').remove();
        $('style').remove();
        $('nav').remove();
        $('footer').remove();
        $('header').remove();

        // Extract text
        const text = $('body').text().replace(/\s+/g, ' ').trim();

        // Analyze with Gemini
        let analysis = "Analysis pending or failed.";
        if (process.env.GEMINI_API_KEY) {
            try {
                const prompt = `
Analyze the following text from a website (${url}). Provide a comprehensive and detailed analysis.

**Output Structure:**

1.  **Executive Summary**: A concise paragraph summarizing the main topic and purpose of the web page.
2.  **Detailed Key Points**: A bulleted list of the most important information, facts, or arguments presented. Be specific.
3.  **Action Items & Deadlines**: Extract any tasks, calls to action, or specific dates/deadlines mentioned. If none, state "None identified."
4.  **Technical/Medical Terminology**: If the text contains specialized terms (medical, legal, technical), list and briefly define them based on context.
5.  **Unresolved Questions**: Identify any questions raised in the text that remain unanswered or require follow-up.

**Text Content:**
${text.substring(0, 20000)}
`;
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
            analysis: analysis,
            type: 'url'
        };
        log(`Finished processing URL: ${url}`);

    } catch (err) {
        console.error(`Error processing URL ${url}:`, err);
        throw err;
    }
}

// Initialize Watcher (only in local development, not in Vercel)
if (process.env.NODE_ENV !== 'production') {
    const watcher = chokidar.watch(DATA_DIR, {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true
    });

    watcher
        .on('add', filePath => {
            // Ignore JSON files in watcher to prevent double processing or loops
            if (filePath.endsWith('.pdf')) {
                log(`File added: ${filePath}`);
                processPDF(filePath);
            }
        })
        .on('change', filePath => {
            if (filePath.endsWith('.pdf')) {
                log(`File changed: ${filePath}`);
                processPDF(filePath);
            }
        })
        .on('error', error => console.log(`Watcher error: ${error}`));

    // Process existing files on startup
    fs.readdir(DATA_DIR, (err, files) => {
        if (err) {
            console.error("Error reading data directory:", err);
            return;
        }
        files.forEach(file => {
            if (file.toLowerCase().endsWith('.pdf')) {
                processPDF(path.join(DATA_DIR, file));
            }
        });
    });
}

// Initialize Drive Sync on startup (works in both local and Vercel)
async function initializeDriveSync() {
    const driveFolderId = process.env.DRIVE_FOLDER_ID;
    if (driveFolderId) {
        log(`Starting Drive Sync for folder: ${driveFolderId} to ${DATA_DIR}`);

        // Initial sync (downloads PDFs AND JSONs)
        await syncDriveFiles(driveFolderId, DATA_DIR, log);

        // Explicitly process files after sync
        log("Drive Sync complete. Processing downloaded files...");
        try {
            const files = fs.readdirSync(DATA_DIR);
            for (const file of files) {
                if (file.toLowerCase().endsWith('.pdf')) {
                    await processPDF(path.join(DATA_DIR, file));
                }
            }
        } catch (err) {
            console.error("Error processing synced files:", err);
        }

        // Poll every 5 minutes (only in local dev)
        if (process.env.NODE_ENV !== 'production') {
            setInterval(() => {
                syncDriveFiles(driveFolderId, DATA_DIR, log);
            }, 5 * 60 * 1000);
        }
    } else {
        log("Drive Sync skipped: DRIVE_FOLDER_ID not set");
    }
    driveSyncInitialized = true;
}

// For local development
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
        // Initialize Drive Sync immediately in local dev
        initializeDriveSync();
    });
}

// Export for Vercel
module.exports = app;
