const axios = require('axios');

async function test() {
  try {
    const resp = await axios.post('http://localhost:3000/chat', {
      message: 'Send an email to test@example.com saying hello'
    });
    console.log(resp.data);
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
  }
}

test();