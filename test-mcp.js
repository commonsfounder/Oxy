const axios = require('axios');

async function test() {
  try {
    console.log('Testing port 3000...');
    const resp = await axios.post('http://localhost:3000/tools', {
      name: 'get_emails',
      arguments: { max_results: 5 }
    });
    console.log(resp.data);
  } catch (e) {
    console.error('Port 3000 error:', e.message);
    try {
      console.log('Testing port 3100...');
      const resp2 = await axios.post('http://localhost:3100/tools', {
        name: 'get_emails',
        arguments: { max_results: 5 }
      });
      console.log(resp2.data);
    } catch (e2) {
      console.error('Port 3100 error:', e2.message);
    }
  }
}

test();