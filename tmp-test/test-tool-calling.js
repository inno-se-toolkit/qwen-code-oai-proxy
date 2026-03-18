const OpenAI = require('openai');

async function testToolCalling() {
  console.log('Testing tool calling with Qwen OpenAI Proxy...');
  
  // Create OpenAI client pointing to our proxy
  const openai = new OpenAI({
    apiKey: 'fake-api-key', // Not actually used, but required by OpenAI client
    baseURL: 'http://localhost:8080/v1' // Point to our proxy
  });
  
  try {
    // Test tool calling
    console.log('\nTesting tool calling...');
    const chatCompletion = await openai.chat.completions.create({
      model: 'qwen3-coder-plus',
      messages: [
        {"role": "user", "content": "What is the weather in New York?"}
      ],
      tools: [
        {
          "type": "function",
          "function": {
            "name": "get_weather",
            "description": "Get the current weather in a given location",
            "parameters": {
              "type": "object",
              "properties": {
                "location": {
                  "type": "string",
                  "description": "The city and state, e.g. San Francisco, CA"
                }
              },
              "required": ["location"]
            }
          }
        }
      ],
      tool_choice: "auto"
    });
    
    console.log('Response received:');
    console.log(JSON.stringify(chatCompletion, null, 2));
    
    // Check if tool calls were returned
    if (chatCompletion.choices && chatCompletion.choices[0].message.tool_calls) {
      console.log('\n✅ Tool calling is working!');
      console.log('Tool calls found:', chatCompletion.choices[0].message.tool_calls.length);
      for (const toolCall of chatCompletion.choices[0].message.tool_calls) {
        console.log(`- Function: ${toolCall.function.name}`);
        console.log(`  Arguments: ${toolCall.function.arguments}`);
      }
    } else {
      console.log('\n❌ No tool calls in response');
      console.log('Response content:', chatCompletion.choices[0].message.content);
    }
    
  } catch (error) {
    console.error('Test failed:', error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('\nIt looks like the proxy server is not running.');
      console.log('Please start the proxy server with: pnpm start');
    }
  }
}

testToolCalling();