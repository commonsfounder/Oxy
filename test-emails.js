const axios = require('axios');

async function test() {
  try {
    const resp = await axios.post('http://localhost:3000/chat', {
      message: 'Check my recent emails'
    });
    console.log(JSON.stringify(resp.data, null, 2));
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
  }
}

test();