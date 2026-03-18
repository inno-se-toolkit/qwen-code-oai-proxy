const OpenAI = require('openai');

async function testRegularChat() {
  console.log('Testing regular chat completion with Qwen OpenAI Proxy...');
  
  // Create OpenAI client pointing to our proxy
  const openai = new OpenAI({
    apiKey: 'fake-api-key', // Not actually used, but required by OpenAI client
    baseURL: 'http://localhost:8080/v1' // Point to our proxy
  });
  
  try {
    // Test regular chat completion
    console.log('\nTesting regular chat completion...');
    const chatCompletion = await openai.chat.completions.create({
      model: 'qwen3-coder-plus',
      messages: [
        {"role": "user", "content": "Hello, how are you?"}
      ],
      temperature: 0.7
    });
    
    console.log('Response received:');
    console.log(JSON.stringify(chatCompletion, null, 2));
    
    // Check if we got a regular response
    if (chatCompletion.choices && chatCompletion.choices[0].message.content) {
      console.log('\n✅ Regular chat completion is working!');
      console.log('Response:', chatCompletion.choices[0].message.content);
    } else {
      console.log('\n❌ No content in response');
    }
    
  } catch (error) {
    console.error('Test failed:', error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('\nIt looks like the proxy server is not running.');
      console.log('Please start the proxy server with: pnpm start');
    }
  }
}

testRegularChat();