/**
 * Unified error response formatting utility
 */

interface ErrorBody {
  error: {
    message: string;
    type: string;
    code: number;
  };
}

interface ErrorResponse {
  status: number;
  body: ErrorBody;
}

class ErrorFormatter {
  /**
   * Standardize OpenAI format error response
   */
  static openAIApiError(message: string, type: string = 'api_error', code: number = 500): ErrorResponse {
    return {
      status: code,
      body: {
        error: {
          message: message,
          type: type,
          code: code
        }
      }
    };
  }

  /**
   * Standardize validation error response (OpenAI format)
   */
  static openAIValidationError(message: string): ErrorResponse {
    return this.openAIApiError(message, 'validation_error', 400);
  }

  /**
   * Standardize authentication error response (OpenAI format)
   */
  static openAIAuthError(message: string = 'Not authenticated with Qwen. Please authenticate first.'): ErrorResponse {
    return this.openAIApiError(message, 'authentication_error', 401);
  }

  /**
   * Standardize rate limit error response (OpenAI format)
   */
  static openAIRateLimitError(message: string = 'Rate limit exceeded'): ErrorResponse {
    return this.openAIApiError(message, 'rate_limit_exceeded', 429);
  }
}

export { ErrorFormatter, ErrorResponse, ErrorBody };
