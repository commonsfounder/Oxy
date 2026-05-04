require('dotenv').config();
const http = require('http');
const url = require('url');
const axios = require('axios');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const PORT = 8765;

const server = http.createServer((req, res) => {
  const query = url.parse(req.url, true).query;
  
  if (query.code) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Code received! Check your terminal.</h1>');
    server.close();
    
    (async () => {
      try {
        const params = new URLSearchParams();
        params.append('client_id', CLIENT_ID);
        params.append('client_secret', CLIENT_SECRET);
        params.append('code', query.code);
        params.append('grant_type', 'authorization_code');
        params.append('redirect_uri', `http://localhost:${PORT}`);

        const resp = await axios.post('https://oauth2.googleapis.com/token', params);

        console.log('\n=== Success! ===\n');
        console.log('Add this to your .env file:\n');
        console.log(`GMAIL_REFRESH_TOKEN=${resp.data.refresh_token}\n`);
      } catch (e) {
        console.error('Error:', e.response?.data || e.message);
      }
    })();
  }
});

server.listen(PORT, () => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    'client_id=' + CLIENT_ID +
    '&redirect_uri=http://localhost:' + PORT +
    '&response_type=code' +
    '&scope=https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' +
    '&access_type=offline';

  console.log('\n=== Gmail OAuth Setup ===\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Sign in to your Google account');
  console.log('3. Click "Continue" to grant permissions');
  console.log('4. You\'ll be redirected to a success page\n');
});