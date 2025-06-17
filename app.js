const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const axios = require('axios');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const port = 3010;

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// MillionVerifier API key from .env
const MILLIONVERIFIER_API_KEY = process.env.MILLIONVERIFIER_API_KEY;

// Google Sheets API setup
const auth = new google.auth.GoogleAuth({
  keyFile: '/creds.json', // Path to your service account key
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Google Sheet ID from .env
const spreadsheetId = process.env.SPREADSHEET_ID;

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Email Verification Entity',
      version: '1.0.0',
      description: 'API for uploading and reading CSV files with email verification using MillionVerifier',
    },
    servers: [
      {
        url: 'http://localhost:3010',
      },
    ],
  },
  apis: ['./app.js'],
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Middleware to parse JSON
app.use(express.json());

// Function to check the available credits
async function checkAvailableCredits() {
  try {
    const response = await axios.get('https://api.millionverifier.com/api/v3/credits', {
      params: {
        api: MILLIONVERIFIER_API_KEY,
      },
    });
    return {
      credits: response.data.credits,
      details: response.data,
    };
  } catch (error) {
    return {
      credits: null,
      details: error.message,
    };
  }
}

// Function to verify email using MillionVerifier API
async function verifyEmail(email) {
  try {
    const response = await axios.get('https://api.millionverifier.com/api/v3/', {
      params: {
        api: MILLIONVERIFIER_API_KEY,
        email: email,
      },
    });
    return {
      email,
      status: response.data.result,
      quality: response.data.quality,
      details: response.data,
    };
  } catch (error) {
    return {
      email,
      status: 'error',
      details: error.message,
    };
  }
}

/**
 * @swagger
 * /credits:
 *   get:
 *     summary: Check available MillionVerifier API credits
 *     tags: [Credits]
 *     responses:
 *       200:
 *         description: Available credits retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 credits:
 *                   type: integer
 *                   nullable: true
 *                 details:
 *                   type: object
 *       500:
 *         description: Error retrieving credits
 */
app.get('/credits', async (req, res) => {
  try {
    const result = await checkAvailableCredits();
    res.json({
      message: 'Credits retrieved successfully',
      credits: result.credits,
      details: result.details,
    });
  } catch (error) {
    res.status(500).json({ error: 'Error retrieving credits', details: error.message });
  }
});

/**
 * @swagger
 * /upload:
 *   post:
 *     summary: Upload a CSV file, verify email addresses, and append to Google Sheet
 *     tags: [CSV]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: File uploaded, emails verified, and data appended to Google Sheet successfully
 *       400:
 *         description: No file uploaded or invalid CSV format
 *       500:
 *         description: Error processing file, verifying emails, or appending to Google Sheet
 */
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const results = [];
  const verificationResults = [];

  // Read and parse the CSV file
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      try {
        // Verify each email in the CSV
        for (const row of results) {
          if (row.email) {
            const verification = await verifyEmail(row.email);
            verificationResults.push({
              ...row,
              verification: verification.status,
              verificationDetails: JSON.stringify(verification.details), // Stringify details for Google Sheet
            });
          } else {
            verificationResults.push({
              ...row,
              verification: 'error',
              verificationDetails: 'No email field found in CSV row',
            });
          }
        }

        // Create a new tab in Google Sheet
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sheetName = `Data_${timestamp}`;

        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [
                {
                  addSheet: {
                    properties: {
                      title: sheetName,
                    },
                  },
                },
              ],
            },
          });
        } catch (error) {
          throw new Error(`Failed to create new sheet: ${error.message}`);
        }

        // Prepare data for Google Sheet
        if (verificationResults.length > 0) {
          const headers = Object.keys(verificationResults[0]);
          const values = verificationResults.map((row) => headers.map((header) => row[header] || ''));

          try {
            await sheets.spreadsheets.values.append({
              spreadsheetId,
              range: `${sheetName}!A1`,
              valueInputOption: 'RAW',
              requestBody: {
                values: [headers, ...values], // Headers + data
              },
            });
          } catch (error) {
            throw new Error(`Failed to append data to Google Sheet: ${error.message}`);
          }
        }

        // Delete the temporary file
        fs.unlinkSync(req.file.path);

        res.json({
          message: `File uploaded, emails verified, and data appended to Google Sheet tab: ${sheetName}`,
          data: verificationResults,
        });
      } catch (error) {
        // Delete the temporary file in case of error
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Error processing file or appending to Google Sheet', details: error.message });
      }
    })
    .on('error', (error) => {
      // Delete the temporary file in case of error
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(500).json({ error: 'Error processing file', details: error.message });
    });
});

/**
 * @swagger
 * /read/{filename}:
 *   get:
 *     summary: Read a CSV file and verify email addresses
 *     tags: [CSV]
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the CSV file to read
 *     responses:
 *       200:
 *         description: CSV file content with email verification
 *       404:
 *         description: File not found
 *       500:
 *         description: Error reading file or verifying emails
 */
app.get('/read/:filename', async (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const results = [];
  const verificationResults = [];

  fs.createReadStream(filePath)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      try {
        // Verify each email in the CSV
        for (const row of results) {
          if (row.email) {
            const verification = await verifyEmail(row.email);
            verificationResults.push({
              ...row,
              verification: verification.status,
              verificationDetails: verification.details,
            });
          } else {
            verificationResults.push({
              ...row,
              verification: 'error',
              verificationDetails: 'No email field found in CSV row',
            });
          }
        }

        res.json({
          message: 'File read and emails verified successfully',
          data: verificationResults,
        });
      } catch (error) {
        res.status(500).json({ error: 'Error verifying emails', details: error.message });
      }
    })
    .on('error', (error) => {
      res.status(500).json({ error: 'Error reading file', details: error.message });
    });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Swagger docs available at http://localhost:${port}/docs`);
});