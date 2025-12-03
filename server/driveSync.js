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

        // Updated query to include JSON files
        const res = await drive.files.list({
            q: `'${folderId}' in parents and (mimeType = 'application/pdf' or mimeType = 'application/json') and trashed = false`,
            fields: 'files(id, name, modifiedTime, mimeType)',
        });

        const files = res.data.files;
        if (!files || files.length === 0) {
            logFn('Drive Sync: No matching PDF/JSON files found.');

            // DIAGNOSTIC 1: Check if ANY files exist in the target folder
            try {
                logFn('Drive Sync Diagnostic: Checking for ANY files in target folder...');
                const diagRes = await drive.files.list({
                    q: `'${folderId}' in parents and trashed = false`,
                    fields: 'files(id, name, mimeType)',
                    pageSize: 5
                });
                const diagFiles = diagRes.data.files;
                if (diagFiles && diagFiles.length > 0) {
                    logFn(`Drive Sync Diagnostic: Found ${diagFiles.length} files in folder (ignoring filter):`);
                    diagFiles.forEach(f => logFn(` - ${f.name} (${f.mimeType})`));
                } else {
                    logFn('Drive Sync Diagnostic: Target folder appears completely empty to this account.');

                    // DIAGNOSTIC 2: Check GLOBAL visibility (Did we share the wrong folder?)
                    logFn('Drive Sync Diagnostic: Checking GLOBAL file visibility...');
                    const globalRes = await drive.files.list({
                        q: "trashed = false",
                        fields: 'files(id, name, parents)',
                        pageSize: 5
                    });
                    const globalFiles = globalRes.data.files;
                    if (globalFiles && globalFiles.length > 0) {
                        logFn(`Drive Sync Diagnostic: Found ${globalFiles.length} files globally accessible:`);
                        globalFiles.forEach(f => {
                            const parentId = f.parents ? f.parents[0] : 'No Parent';
                            logFn(` - ${f.name} (Parent ID: ${parentId})`);
                            if (parentId !== folderId) {
                                logFn(`   ^^ WARNING: Parent ID ${parentId} does NOT match configured folder ID ${folderId}`);
                            }
                        });
                    } else {
                        logFn('Drive Sync Diagnostic: This Service Account cannot see ANY files anywhere. Sharing definitely failed.');
                    }
                }
            } catch (diagErr) {
                logFn(`Drive Sync Diagnostic Error: ${diagErr.message}`);
            }

            return;
        }

        const downloaded = loadDownloadedFiles(downloadDir);
        let newFilesCount = 0;

        for (const file of files) {
            // Check if we need to download (if not downloaded or if modified on Drive)
            // For simplicity, we just check if ID is in record. 
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

        // Create filename with "_notebook_summary" suffix
        const baseName = path.basename(originalFileName, path.extname(originalFileName));
        const summaryFileName = `${baseName}_notebook_summary.txt`;

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

async function uploadFileToDrive(folderId, filePath, mimeType = 'application/json', logFn = console.log) {
    if (!folderId) throw new Error('Drive Folder ID not provided');

    const fileName = path.basename(filePath);
    logFn(`Uploading ${fileName} to Drive...`);

    try {
        const authClient = await authenticate();
        const drive = google.drive({ version: 'v3', auth: authClient });

        const fileMetadata = {
            name: fileName,
            parents: [folderId]
        };

        const media = {
            mimeType: mimeType,
            body: fs.createReadStream(filePath)
        };

        const response = await drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id, name'
        });

        logFn(`Successfully uploaded: ${response.data.name} (ID: ${response.data.id})`);
        return response.data;
    } catch (error) {
        logFn(`Error uploading file: ${error.message}`);
        throw error;
    }
}

async function deleteFileFromDrive(folderId, fileName, logFn = console.log) {
    if (!folderId) throw new Error('Drive Folder ID not provided');

    logFn(`Attempting to delete ${fileName} from Drive...`);

    try {
        const authClient = await authenticate();
        const drive = google.drive({ version: 'v3', auth: authClient });

        // Find file by name
        const res = await drive.files.list({
            q: `'${folderId}' in parents and name = '${fileName}' and trashed = false`,
            fields: 'files(id, name)',
        });

        const files = res.data.files;
        if (!files || files.length === 0) {
            logFn(`File ${fileName} not found in Drive.`);
            return false;
        }

        // Delete all matches (though usually should be one)
        for (const file of files) {
            await drive.files.delete({ fileId: file.id });
            logFn(`Deleted ${fileName} (ID: ${file.id}) from Drive.`);
        }
        return true;

    } catch (error) {
        logFn(`Error deleting file from Drive: ${error.message}`);
        throw error;
    }
}

module.exports = { syncDriveFiles, uploadSummaryToDrive, uploadFileToDrive, deleteFileFromDrive };
