# Token Usage Tracking

## Overview

The Qwen OpenAI Proxy now includes comprehensive token usage tracking functionality that monitors and reports on input and output token consumption across all accounts and request types.

## Features

- **Daily Token Tracking**: Records input tokens (prompt) and output tokens (completion) for each day
- **Multi-Account Support**: Aggregates token usage across all configured accounts
- **Streaming & Regular Requests**: Tracks tokens from both streaming and non-streaming API responses
- **Persistent Storage**: Token usage data is stored locally in `~/.qwen/request_counts.json`
- **Clean Terminal Display**: Beautiful table-based reporting with `pnpm run auth:tokens`

## How It Works

### Data Collection
1. **Regular Requests**: Token usage is extracted from the `usage` field in API responses
2. **Streaming Requests**: Token usage is captured from the final chunk of streaming responses
3. **Daily Aggregation**: Usage is automatically grouped by date and account

### Data Storage
Token usage data is stored in the existing `request_counts.json` file alongside request counts:
```json
{
  "lastResetDate": "2025-08-22",
  "requests": {
    "default": 45,
    "account2": 82
  },
  "tokenUsage": {
    "default": [
      {"date": "2025-08-20", "inputTokens": 12500, "outputTokens": 8300},
      {"date": "2025-08-21", "inputTokens": 15200, "outputTokens": 9100}
    ]
  }
}
```

## Usage

### View Token Usage Report

You can use either of these commands to view token usage reports:

```bash
pnpm run auth:tokens
```

or

```bash
pnpm run tokens
```

Both commands display a clean table showing:
- Daily input tokens, output tokens, and totals
- Overall lifetime totals
- Total request count

### Example Output
```
📊 Qwen Token Usage Report
═══════════════════════════════════════════════════════════════════════════════

┌────────────┬───────────────┬────────────────┬───────────────┐
│ Date       │ Input Tokens  │ Output Tokens  │ Total Tokens  │
├────────────┼───────────────┼────────────────┼───────────────┤
│ 2025-08-20 │ 12,500        │ 8,300          │ 20,800        │
│ 2025-08-21 │ 15,200        │ 9,100          │ 24,300        │
│ 2025-08-22 │ 8,750         │ 5,400          │ 14,150        │
├────────────┼───────────────┼────────────────┼───────────────┤
│ TOTAL      │ 36,450        │ 22,800         │ 59,250        │
└────────────┴───────────────┴────────────────┴───────────────┘

Total Requests: 127
```

## Technical Implementation

### Core Components
- **QwenAPI Class**: Enhanced with token tracking methods
- **tokens.js**: Terminal display script with table formatting
- **cli-table3**: package for beautiful terminal tables

### Key Methods
- `recordTokenUsage(accountId, inputTokens, outputTokens)`: Records daily token usage
- `loadRequestCounts()` / `saveRequestCounts()`: Handle persistent storage
- Daily aggregation automatically combines data from all accounts

## Dependencies
- `cli-table3`: Terminal table formatting (automatically installed)

## Data Privacy
All token usage data is stored locally and never transmitted externally. The system only tracks usage statistics for your own monitoring and budgeting purposes.