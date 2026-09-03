# 🎙️ VOXOPS

## The Voice Agent That Doesn't Just Talk — It Takes Action.

> **A real-time autonomous voice operations agent built with AssemblyAI.**

[![AssemblyAI](https://img.shields.io/badge/Powered%20by-AssemblyAI-black)](https://www.assemblyai.com/)
[![Real-Time](https://img.shields.io/badge/Voice-Real--Time-blue)](#)
[![WebSocket](https://img.shields.io/badge/Transport-WebSocket-green)](#)
[![Status](https://img.shields.io/badge/Status-Prototype-orange)](#)

---

## 🧠 What Is VOXOPS?

VOXOPS is a real-time voice AI agent designed to **understand spoken requests, reason about what needs to happen, interact with external tools, and actually complete tasks.**

Most voice assistants stop at:

> **Listen → Understand → Answer**

VOXOPS is designed around:

> **Listen → Understand → Reason → Act → Verify → Respond**

The user should be able to speak naturally instead of learning commands, filling forms, or navigating complicated dashboards.

### Example

**User:**

> "Check my order. If it's delayed, find out why and create a support request."

VOXOPS can:

```text
🎙️ User speaks
       ↓
🧠 Real-time speech recognition
       ↓
🎯 Intent + context understanding
       ↓
🤖 Agent reasoning
       ↓
🔧 Tool selection
       ↓
📦 Order lookup
       ↓
⚠️ Delay detected
       ↓
🔧 Support-ticket tool
       ↓
✅ Action verified
       ↓
🔊 Natural spoken response
```

The important part:

**The AI doesn't just tell the user what they could do.**

It does it.

---

# 🏆 Hackathon

VOXOPS is being developed for the:

## AssemblyAI Voice Agent Hackathon

**Organizer:** lablab.ai × AssemblyAI
**Dates:** September 1–30, 2026
**Format:** Online
**Prize Pool:** $10,000

The challenge requires projects to build voice agents using AssemblyAI's real-time voice technology.

There are two official implementation paths:

### Path A — AssemblyAI Voice Agent API

AssemblyAI handles the core voice pipeline:

* Speech-to-text
* LLM interaction
* Text-to-speech
* Turn-taking
* Voice activity detection
* Tool calling
* Real-time voice interaction

This is the recommended path for VOXOPS because it lets us spend our engineering time on the **agent itself**, rather than rebuilding the entire speech pipeline.

### Path B — AssemblyAI Realtime Speech-to-Text API

AssemblyAI provides real-time transcription while we build our own:

* LLM orchestration
* TTS
* Agent logic
* Tool system
* Conversation management

This provides more control but also significantly more engineering work.

---

# 🚨 The Core Problem

Traditional software makes humans adapt to computers.

You have to:

```text
Open website
      ↓
Find menu
      ↓
Find account
      ↓
Find order
      ↓
Find support
      ↓
Fill form
      ↓
Submit
      ↓
Wait
```

VOXOPS changes the interface.

The user simply speaks:

> "My order is late. Check what happened and get someone to help me."

The agent determines what needs to happen.

---

# 🎯 Core Design Philosophy

VOXOPS follows five principles.

## 1. Voice First

The primary interaction is speech.

The interface should not feel like:

> "Chatbot with a microphone."

It should feel like:

> "I'm talking to an intelligent assistant."

---

## 2. Action Over Answers

The agent should perform useful operations.

Examples:

* Search information
* Query databases
* Create records
* Update records
* Schedule actions
* Generate reports
* Send notifications
* Escalate to humans
* Verify results

---

## 3. Real-Time

The agent must feel responsive.

The user should see/hear:

```text
Listening...
   ↓
Understanding...
   ↓
Thinking...
   ↓
Acting...
   ↓
Responding...
```

rather than waiting for a giant request/response cycle.

AssemblyAI's current Voice Agent API is specifically designed around low-latency conversational interaction and provides turn detection and interruption handling as part of the pipeline.

---

## 4. Tool-Driven Intelligence

The LLM should not directly control the application.

Instead:

```text
LLM
 ↓
Tool decision
 ↓
Validated backend function
 ↓
External system
 ↓
Tool result
 ↓
LLM
 ↓
Voice response
```

This gives the system controlled, observable actions.

---

## 5. Human Handoff

A good agent must know when it should stop pretending to be capable of everything.

If the request requires a human:

```text
AI
 ↓
Detect escalation
 ↓
Summarize conversation
 ↓
Transfer / create escalation
 ↓
Human receives context
```

The user shouldn't have to explain everything again.

AssemblyAI's current Voice Agent architecture supports JSON-Schema tool calling, which makes this kind of controlled action interface practical.

---

# 🏗️ System Architecture

```text
                    ┌──────────────────────┐
                    │      USER            │
                    │   🎙️ Microphone      │
                    └──────────┬───────────┘
                               │
                               │ Audio
                               ▼
                    ┌──────────────────────┐
                    │     FRONTEND         │
                    │ React / Vite         │
                    │ Audio UI             │
                    │ Live transcript      │
                    │ Agent state          │
                    └──────────┬───────────┘
                               │
                               │ WebSocket
                               ▼
              ┌────────────────────────────────┐
              │       ASSEMBLYAI               │
              │                                │
              │   Voice Agent API              │
              │                                │
              │   ┌────────────────────────┐   │
              │   │ Speech Recognition     │   │
              │   ├────────────────────────┤   │
              │   │ Turn Detection        │   │
              │   ├────────────────────────┤   │
              │   │ LLM                    │   │
              │   ├────────────────────────┤   │
              │   │ Text-to-Speech         │   │
              │   └────────────────────────┘   │
              └───────────────┬────────────────┘
                              │
                         Tool Calls
                              │
                              ▼
                    ┌──────────────────────┐
                    │   AGENT BACKEND      │
                    │   Node / Python      │
                    └──────────┬───────────┘
                               │
             ┌─────────────────┼──────────────────┐
             │                 │                  │
             ▼                 ▼                  ▼
       ┌───────────┐     ┌───────────┐      ┌───────────┐
       │ Database  │     │ APIs      │      │ Actions   │
       │           │     │           │      │           │
       │ Users     │     │ External  │      │ Tickets   │
       │ Orders    │     │ Services  │      │ Alerts    │
       │ History   │     │           │      │ Reports   │
       └───────────┘     └───────────┘      └───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Verification Layer   │
                    │                      │
                    │ Did action succeed?  │
                    │ What changed?        │
                    └──────────┬───────────┘
                               │
                               ▼
                    🔊 Spoken Response
```

---

# ⚙️ Technology Stack

## Voice Layer

**AssemblyAI Voice Agent API**

Responsible for the real-time conversational voice pipeline.

Expected capabilities:

* Real-time speech recognition
* Voice activity detection
* Turn-taking
* LLM interaction
* Speech generation
* Interruptions
* Tool calling

---

## Frontend

Recommended:

```text
React
Vite
TypeScript
Web Audio API
AudioWorklet
```

Responsibilities:

* Microphone permission
* Audio streaming
* Connection state
* Live transcript
* Agent status
* Tool activity
* Errors
* Conversation history

---

## Backend

Recommended:

```text
Node.js
TypeScript
WebSocket
Express / Fastify
```

Responsibilities:

* Keep API credentials server-side
* Manage sessions
* Execute tools
* Validate tool parameters
* Connect databases
* Connect external APIs
* Logging
* Error handling
* Authentication

---

## Database

For prototype:

```text
PostgreSQL
```

Alternative:

```text
SQLite
```

The database should contain realistic demo data.

Example:

```text
users
orders
tickets
activities
notifications
sessions
tool_events
```

---

# 🔧 Tool System

Tools are the most important part of VOXOPS.

The agent should not be given unrestricted access to the backend.

Every action becomes a controlled function.

Example:

```json
{
  "type": "function",
  "name": "get_order_status",
  "description": "Retrieve the current status of an order",
  "parameters": {
    "type": "object",
    "properties": {
      "order_id": {
        "type": "string"
      }
    },
    "required": ["order_id"]
  }
}
```

Possible tools:

```text
get_order_status
get_customer
search_knowledge
create_support_ticket
update_order
schedule_callback
send_notification
generate_report
transfer_to_human
```

---

# 🧠 Agent State Machine

The agent should have explicit states.

```text
                    ┌──────────┐
                    │  IDLE    │
                    └────┬─────┘
                         │
                         ▼
                   ┌───────────┐
                   │ LISTENING │
                   └─────┬─────┘
                         │
                         ▼
                   ┌───────────┐
                   │ THINKING  │
                   └─────┬─────┘
                         │
                 ┌───────┴────────┐
                 │                │
                 ▼                ▼
             RESPOND          TOOL CALL
                 │                │
                 │                ▼
                 │           TOOL RUNNING
                 │                │
                 │                ▼
                 │           VERIFY RESULT
                 │                │
                 └───────┬────────┘
                         ▼
                     SPEAKING
                         │
                  interruption?
                    ┌────┴────┐
                   YES        NO
                    │          │
                    ▼          ▼
                 LISTENING    IDLE
```

---

# ⚡ Interruption / Barge-In

This is mandatory for making the application feel like a real conversation.

Bad experience:

> AI: "Your order is currently—"

User:

> "Wait, stop."

AI:

> "...currently scheduled for delivery tomorrow and—"

❌ Terrible.

Correct behavior:

```text
AI speaking
     ↓
User interrupts
     ↓
Playback stops
     ↓
Agent switches to listening
     ↓
New utterance processed
```

AssemblyAI's Voice Agent API provides turn-taking and barge-in functionality, making this substantially easier than implementing the entire mechanism ourselves.

---

# 🛠️ Tool Execution Lifecycle

Every tool call should follow:

```text
Agent requests tool
       ↓
Validate schema
       ↓
Validate authorization
       ↓
Execute function
       ↓
Timeout protection
       ↓
Capture result
       ↓
Verify result
       ↓
Return structured result
       ↓
Agent explains result
```

Never:

```text
LLM → arbitrary database query
```

Prefer:

```text
LLM
 ↓
approved function
 ↓
validated parameters
 ↓
backend
```

---

# 🧯 Failure Recovery

This is one of the features that can separate VOXOPS from basic demos.

Example:

> "Create a support ticket."

Backend fails.

The agent should NOT say:

> "Done!"

Instead:

```text
Tool requested
      ↓
API failure
      ↓
Retry
      ↓
Still failed
      ↓
Record failure
      ↓
Tell user
      ↓
Offer alternative
```

Example response:

> "I couldn't create the ticket because the support service is temporarily unavailable. I saved the request locally and can retry it."

The agent must never fabricate successful actions.

---

# 🔐 Security

API keys must NEVER be placed in frontend JavaScript.

Bad:

```text
React
 ↓
AssemblyAI API key
```

Correct:

```text
Browser
 ↓
Backend
 ↓
AssemblyAI
```

Use environment variables:

```env
ASSEMBLYAI_API_KEY=
DATABASE_URL=
LLM_API_KEY=
```

Add:

```text
.env
.env.*
```

to `.gitignore`.

Never commit secrets.

---

# 📊 Observability

The application should expose what the agent is doing.

Example UI:

```text
┌─────────────────────────────────────┐
│          VOXOPS LIVE                │
├─────────────────────────────────────┤
│                                     │
│  🎙️ Listening                      │
│                                     │
│  "Check my order and create a       │
│   support ticket if delayed."       │
│                                     │
├─────────────────────────────────────┤
│ AGENT ACTIVITY                      │
│                                     │
│ ✓ Speech recognized                 │
│ ✓ Intent detected                   │
│ ✓ get_order_status                  │
│ ✓ Order delay detected              │
│ → create_support_ticket             │
│ ✓ Ticket created                    │
│                                     │
├─────────────────────────────────────┤
│ STATUS: Ready                       │
└─────────────────────────────────────┘
```

This makes the demo understandable to judges.

---

# 📈 Metrics

We should measure:

```text
Time to first response
Time to first audio
Total response latency
Tool execution time
Tool success rate
Connection failures
Interruption response time
Transcript accuracy
Task completion rate
```

Example dashboard:

```text
Average response latency     0.8s
Tool success rate            98.7%
Task completion              94.2%
Interruptions handled       100%
Failed actions               3
```

These metrics make the project look engineered rather than improvised.

---

# 🧪 Demo Scenarios

The demo should contain predefined scenarios.

## Scenario 1 — Simple Question

User:

> "What's the status of order ORD-1024?"

Agent:

```text
→ get_order_status
→ result
→ speak response
```

---

## Scenario 2 — Multi-Step Task

User:

> "Check order ORD-1024 and create a support ticket if it's delayed."

Agent:

```text
→ get_order_status
→ detect delay
→ create_support_ticket
→ verify ticket
→ respond
```

---

## Scenario 3 — Interruption

Agent:

> "Your order is currently scheduled for—"

User:

> "Wait, which address?"

Agent stops immediately and handles the new question.

---

## Scenario 4 — Tool Failure

User:

> "Create a support ticket."

Backend intentionally fails.

Agent:

```text
→ detects failure
→ does not hallucinate success
→ explains problem
→ offers retry
```

---

## Scenario 5 — Human Escalation

User:

> "I want to speak to a human."

Agent:

```text
→ detect escalation
→ summarize conversation
→ create escalation
→ provide human handoff
```

AssemblyAI has documented a tool-based human-handoff pattern where the agent can call a transfer tool and pass conversation context to the human operator.

---

# 🖥️ UI

The interface should be extremely simple.

### Main screen

```text
┌────────────────────────────────────────────┐
│ VOXOPS                              ● LIVE │
├────────────────────────────────────────────┤
│                                            │
│             ┌──────────────┐               │
│             │      🎙️      │               │
│             │   LISTENING  │               │
│             └──────────────┘               │
│                                            │
│       "How can I help you today?"          │
│                                            │
├────────────────────────────────────────────┤
│ Conversation                               │
│                                            │
│ YOU                                        │
│ Check my order and contact support.        │
│                                            │
│ VOXOPS                                     │
│ I'll check the order first.                │
│                                            │
├────────────────────────────────────────────┤
│ Agent Activity                             │
│                                            │
│ ✓ Voice recognized                         │
│ ✓ Order lookup                             │
│ ✓ Delay detected                           │
│ ✓ Support ticket created                   │
│                                            │
└────────────────────────────────────────────┘
```

---

# 📁 Project Structure

```text
voxops/
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── audio/
│   │   ├── services/
│   │   ├── state/
│   │   └── App.tsx
│   │
│   ├── public/
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── agent/
│   │   ├── tools/
│   │   ├── websocket/
│   │   ├── database/
│   │   ├── services/
│   │   ├── security/
│   │   └── server.ts
│   │
│   └── package.json
│
├── database/
│   ├── schema.sql
│   └── seed.sql
│
├── docs/
│   ├── architecture.md
│   ├── tools.md
│   └── demo-script.md
│
├── screenshots/
│
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

---

# 🚀 Getting Started

## Requirements

Install:

```text
Node.js 20+
npm
Git
Modern browser
Microphone
AssemblyAI account
AssemblyAI API key
```

Recommended:

```text
VS Code
PostgreSQL
Docker
```

---

# 1. Clone

```bash
git clone https://github.com/YOUR_USERNAME/voxops.git

cd voxops
```

---

# 2. Install Backend

```bash
cd backend
npm install
```

---

# 3. Install Frontend

```bash
cd ../frontend
npm install
```

---

# 4. Configure Environment

Create:

```text
backend/.env
```

Example:

```env
ASSEMBLYAI_API_KEY=your_api_key_here
DATABASE_URL=your_database_url
PORT=8000
```

Never commit this file.

---

# 5. Start Backend

```bash
cd backend
npm run dev
```

---

# 6. Start Frontend

```bash
cd frontend
npm run dev
```

Open the local application in your browser.

Allow microphone access.

Press:

```text
START VOICE SESSION
```

and start talking.

---

# 🔌 API / Tool Layer

Example tools:

| Tool                    | Purpose                       |
| ----------------------- | ----------------------------- |
| `get_order_status`      | Retrieve order information    |
| `get_customer`          | Retrieve customer information |
| `search_knowledge`      | Search internal knowledge     |
| `create_support_ticket` | Create support request        |
| `update_order`          | Modify order state            |
| `schedule_callback`     | Schedule callback             |
| `send_notification`     | Send notification             |
| `generate_report`       | Generate structured report    |
| `transfer_to_human`     | Escalate conversation         |

Every tool must have:

```text
Name
Description
JSON Schema
Authorization
Timeout
Validation
Error handling
Structured response
Logging
```

---

# 🧠 Agent Prompt Strategy

The system prompt should define:

```text
WHO YOU ARE

WHAT YOU CAN DO

WHAT YOU CANNOT DO

AVAILABLE TOOLS

WHEN TO USE EACH TOOL

WHEN TO ASK QUESTIONS

WHEN TO ESCALATE

HOW TO HANDLE FAILURES

HOW TO HANDLE INTERRUPTIONS

NEVER CLAIM AN ACTION SUCCEEDED
UNLESS THE TOOL CONFIRMS IT
```

The model should not invent database results.

It should rely on tools for facts.

---

# ❌ What We Should NOT Build

Avoid these weak implementations:

### ❌ "ChatGPT with a microphone"

Not enough.

### ❌ Static scripted conversation

Judges should be able to change what they say.

### ❌ Fake tool calls

If the UI says:

```text
✓ Ticket created
```

a real backend operation should have happened.

### ❌ Giant latency

A voice agent that waits 5–10 seconds before speaking feels broken.

### ❌ No interruption handling

Talking over the user destroys the experience.

### ❌ No failure handling

Real agents fail.

Show how ours recovers.

### ❌ Generic interview bot

The current hackathon already has multiple interview-oriented submissions.

VOXOPS should demonstrate a different category of voice agent.

---

# 🏆 What Judges Need To See

The official judging categories are:

## Application of Technology

How effectively the chosen technology/models are integrated.

Therefore:

```text
AssemblyAI
     ↓
Realtime voice
     ↓
Agent
     ↓
Tools
     ↓
Real actions
```

must be obvious.

---

## Presentation

The project needs to be understandable in seconds.

The demo should immediately answer:

```text
What is it?
Why does it matter?
Why voice?
Why is AssemblyAI important?
What can it actually do?
```

---

## Business Value

Don't pitch:

> "We made a cool voice AI."

Pitch:

> "VOXOPS reduces the friction between a user's intention and the action required to complete it."

Possible markets:

```text
Customer support
Operations
Field services
Internal enterprise tools
Scheduling
Sales
IT support
Service desks
```

---

## Originality

The differentiator should be:

> **Voice is not merely the output channel. Voice is the control interface for an action-taking agent.**

---

# 🎬 Demo Video Plan

The video should be short and aggressive.

## 0–10 seconds

Show the problem.

> "Most AI voice agents can answer questions. VOXOPS can actually perform the task."

---

## 10–30 seconds

Show normal voice interaction.

---

## 30–60 seconds

Show multi-step tool execution.

---

## 60–80 seconds

Show interruption.

---

## 80–100 seconds

Show tool failure and recovery.

---

## 100–120 seconds

Show human escalation.

---

## Final

Show architecture and explain:

```text
Voice
 ↓
AssemblyAI
 ↓
Agent
 ↓
Tools
 ↓
Real Action
```

---

# 📑 Pitch Deck

Recommended slides:

### Slide 1

VOXOPS

**The Voice Agent That Actually Gets Things Done**

### Slide 2

Problem

### Slide 3

Solution

### Slide 4

Why Voice?

### Slide 5

Architecture

### Slide 6

AssemblyAI Integration

### Slide 7

Tool Calling

### Slide 8

Real-Time Interaction

### Slide 9

Failure Recovery

### Slide 10

Business Value

### Slide 11

Demo

### Slide 12

Future

---

# 🚨 Hackathon Submission Checklist

Before submission, verify EVERYTHING.

## Required Project Information

* [ ] Project title
* [ ] Short description
* [ ] Long description
* [ ] Technology tags
* [ ] Category tags

## Presentation

* [ ] Cover image
* [ ] Demo/presentation video
* [ ] Pitch deck

## Application

* [ ] Working online prototype
* [ ] Public GitHub repository
* [ ] Public application URL
* [ ] Application can actually be tested

The official challenge submission requirements explicitly list these categories.

---

# 🔥 Technical Completion Checklist

## Voice

* [ ] Microphone works
* [ ] Audio streams correctly
* [ ] Real-time transcription works
* [ ] Agent speaks
* [ ] Turn detection works
* [ ] Interruptions work
* [ ] Reconnection works

## Agent

* [ ] System prompt
* [ ] Conversation state
* [ ] Tool selection
* [ ] Tool validation
* [ ] Tool results
* [ ] Error recovery
* [ ] Escalation

## Backend

* [ ] API authentication
* [ ] Environment variables
* [ ] Database
* [ ] Tool dispatcher
* [ ] Logging
* [ ] Timeouts
* [ ] Error handling

## Frontend

* [ ] Voice button
* [ ] Live transcript
* [ ] Agent state
* [ ] Tool activity
* [ ] Conversation history
* [ ] Error messages
* [ ] Mobile/desktop compatibility

## Deployment

* [ ] HTTPS
* [ ] Public URL
* [ ] Environment variables
* [ ] Production build
* [ ] Backend deployed
* [ ] Database accessible
* [ ] AssemblyAI connection verified

---

# 🧪 Final Testing

Before submission, perform a brutal test.

### Test 1

Say exactly what the demo expects.

### Test 2

Say something unexpected.

### Test 3

Interrupt the agent.

### Test 4

Speak very quickly.

### Test 5

Pause halfway through a sentence.

### Test 6

Give incomplete information.

### Test 7

Ask the agent to perform an invalid action.

### Test 8

Break an external API.

### Test 9

Disconnect the network.

### Test 10

Reconnect.

### Test 11

Ask the agent to escalate.

### Test 12

Ask the same question differently.

If the agent only works when the developer follows a script, it isn't finished.

---

# 🧭 Development Roadmap

## Phase 1 — Skeleton

```text
Frontend
Backend
AssemblyAI connection
Microphone
Basic voice response
```

Goal:

> Talk → AI talks back.

---

## Phase 2 — Agent

```text
System prompt
Conversation state
Tool definitions
Tool dispatcher
```

Goal:

> Talk → Agent understands → Agent chooses tool.

---

## Phase 3 — Real Actions

```text
Database
APIs
Create/update operations
Verification
```

Goal:

> Talk → Agent → Tool → Real result.

---

## Phase 4 — Real-Time Polish

```text
Barge-in
Latency
Streaming
Reconnect
Audio buffering
UI state
```

Goal:

> Make it feel like a real conversation.

---

## Phase 5 — Reliability

```text
Timeouts
Retries
Failure recovery
Human escalation
Logging
Observability
```

Goal:

> Make the agent trustworthy.

---

## Phase 6 — Deployment

```text
Frontend hosting
Backend hosting
Database
HTTPS
Environment variables
Production testing
```

Goal:

> Anyone can open the URL and use it.

---

## Phase 7 — Competition Polish

```text
Landing page
Demo video
Pitch deck
Screenshots
Architecture diagram
Metrics
README
```

Goal:

> Make the engineering obvious to the judges.

---

# 💡 Future Extensions

VOXOPS can eventually become a general-purpose voice operations platform.

Potential integrations:

```text
CRM
ERP
Helpdesk
Calendar
Email
Slack
Databases
Inventory
Payments
Analytics
Internal company APIs
```

The architecture remains:

```text
                    VOICE
                      ↓
                ASSEMBLYAI
                      ↓
                   AGENT
                      ↓
              TOOL ORCHESTRATOR
                      ↓
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
     CRM           DATABASE        APIs
       ↓              ↓              ↓
       └──────────────┼──────────────┘
                      ↓
                 VERIFICATION
                      ↓
                  VOICE RESULT
```

---

# 🧩 Why AssemblyAI?

AssemblyAI is not being added as a checkbox.

It is part of the core interaction layer.

The Voice Agent API provides the infrastructure required for:

```text
Speech recognition
LLM interaction
Speech generation
Turn detection
Voice activity detection
Tool calling
Real-time interaction
```

That allows the project to focus engineering effort on the **agent's intelligence, actions, reliability, and user experience** rather than rebuilding fundamental voice infrastructure.

---

# 📜 License

This project is intended to be released under the MIT License, subject to the applicable hackathon rules and project dependencies.

---

# ⚠️ Disclaimer

VOXOPS is a hackathon prototype.

External actions should be performed only against authorized systems and test data.

Never connect unrestricted production systems to an autonomous agent without appropriate authentication, authorization, validation, logging, and human-approval mechanisms.

---

# 👨‍💻 Built For

**AssemblyAI Voice Agent Hackathon — September 2026**

Built with:

**AssemblyAI + WebSockets + TypeScript + React + real tools + real-time voice AI**

---

# 🚀 The Goal

Don't build another AI that says:

> "I can help you with that."

Build one that says:

> **"I already handled it."**
