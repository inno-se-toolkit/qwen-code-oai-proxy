import { get_encoding } from 'tiktoken';

interface ContentObject {
  content?: string | unknown;
  [key: string]: unknown;
}

type TokenInput = string | unknown[] | ContentObject | unknown;

/**
 * Count tokens in messages using tiktoken
 * @param input - Input to count tokens for
 * @returns Number of tokens
 */
function countTokens(input: TokenInput): number {
  try {
    // Convert input to string format for token counting
    let inputString = '';

    if (typeof input === 'string') {
      inputString = input;
    } else if (Array.isArray(input)) {
      // Handle array of messages
      inputString = JSON.stringify(input);
    } else if (typeof input === 'object' && input !== null) {
      // Handle message objects
      const obj = input as ContentObject;
      if (obj.content) {
        inputString = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content);
      } else {
        inputString = JSON.stringify(input);
      }
    } else {
      inputString = String(input);
    }

    // Use cl100k_base encoding (GPT-4 tokenizer, good approximation for Qwen)
    const encoding = get_encoding('cl100k_base');
    const tokens = encoding.encode(inputString);
    const tokenCount = tokens.length;

    // Clean up encoding resources
    encoding.free();

    return tokenCount;
  } catch (error) {
    console.warn('Error counting tokens, falling back to character approximation:', error);
    // Fallback: rough approximation using character count

    let inputString = '';
    if (typeof input === 'string') {
      inputString = input;
    } else if (Array.isArray(input)) {
      inputString = JSON.stringify(input);
    } else if (typeof input === 'object' && input !== null) {
      const obj = input as ContentObject;
      if (obj.content) {
        inputString = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content);
      } else {
        inputString = JSON.stringify(input);
      }
    } else {
      inputString = String(input);
    }

    return Math.ceil(inputString.length / 4); // Rough estimate: 1 token ≈ 4 characters
  }
}

export { countTokens };
