const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const CREDENTIALS_PATH = path.join(__dirname, '../google-credentials.json');
const DOWNLOAD_RECORD_PATH = path.join(__dirname, 'downloaded_files.json');

async function authenticate() {
    let authOptions = {
        scopes: SCOPES,
    };

    if (process.env.GOOGLE_CREDENTIALS_JSON) {
        // Production (Vercel): Credentials from Env Var
        try {
            const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
            authOptions.credentials = credentials;
        } catch (error) {
            console.error("Error parsing GOOGLE_CREDENTIALS_JSON:", error);
        }
    } else {
        // Local Development: Credentials from file
        authOptions.keyFile = CREDENTIALS_PATH;
    }

    const auth = new google.auth.GoogleAuth(authOptions);
    return auth.getClient();
}

async function downloadFile(drive, fileId, destPath) {
    const dest = fs.createWriteStream(destPath);
    const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
        res.data
            .on('end', () => resolve())
            .on('error', err => reject(err))
            .pipe(dest);
    });
}

function getDownloadRecordPath(dataDir) {
    return path.join(dataDir, 'downloaded_files.json');
}

function loadDownloadedFiles(dataDir) {
    const recordPath = getDownloadRecordPath(dataDir);
    if (fs.existsSync(recordPath)) {
        return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    }
    return {};
}

function saveDownloadedFiles(dataDir, files) {
    const recordPath = getDownloadRecordPath(dataDir);
    fs.writeFileSync(recordPath, JSON.stringify(files, null, 2));
}

async function syncDriveFiles(folderId, downloadDir, logFn = console.log) {
    if (!folderId) {
        logFn("Drive Sync: No Folder ID provided. Skipping.");
        return;
    }

    logFn("Drive Sync: Checking for new files...");
    try {
        const authClient = await authenticate();
        const drive = google.drive({ version: 'v3', auth: authClient });

        const res = await drive.files.list({
            q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
            fields: 'files(id, name, modifiedTime)',
        });

        const files = res.data.files;
        if (!files || files.length === 0) {
            logFn('Drive Sync: No files found.');
            return;
        }

        const downloaded = loadDownloadedFiles(downloadDir);
        let newFilesCount = 0;

        for (const file of files) {
            if (!downloaded[file.id]) {
                logFn(`Drive Sync: Downloading ${file.name}...`);
                const destPath = path.join(downloadDir, file.name);

                try {
                    await downloadFile(drive, file.id, destPath);
                    downloaded[file.id] = {
                        name: file.name,
                        downloadedAt: new Date().toISOString(),
                        driveModifiedTime: file.modifiedTime
                    };
                    newFilesCount++;
                    logFn(`Drive Sync: Downloaded ${file.name}`);
                } catch (err) {
                    logFn(`Drive Sync: Error downloading ${file.name}: ${err.message}`);
                }
            }
        }

        if (newFilesCount > 0) {
            saveDownloadedFiles(downloadDir, downloaded);
            logFn(`Drive Sync: Downloaded ${newFilesCount} new files.`);
        } else {
            logFn("Drive Sync: No new files to download.");
        }

    } catch (error) {
        logFn(`Drive Sync Error: ${error.message}`);
        if (error.response) {
            logFn(`Drive Sync Error Details: ${JSON.stringify(error.response.data)}`);
        }
    }
}

async function uploadSummaryToDrive(folderId, originalFileName, analysisText, logFn = console.log) {
    if (!folderId) {
        throw new Error('Drive Folder ID not provided');
    }

    logFn(`Uploading summary for ${originalFileName} to Drive...`);

    try {
        const authClient = await authenticate();
        const drive = google.drive({ version: 'v3', auth: authClient });

        // Create filename with "notebook özet" suffix
        const baseName = path.basename(originalFileName, path.extname(originalFileName));
        const summaryFileName = `${baseName} notebook özet.txt`;

        const fileMetadata = {
            name: summaryFileName,
            parents: [folderId],
            mimeType: 'text/plain'
        };

        const media = {
            mimeType: 'text/plain',
            body: analysisText
        };

        const response = await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id, name'
        });

        logFn(`Successfully uploaded: ${response.data.name} (ID: ${response.data.id})`);
        return response.data;
    } catch (error) {
        logFn(`Error uploading summary: ${error.message}`);
        throw error;
    }
}

module.exports = { syncDriveFiles, uploadSummaryToDrive };
