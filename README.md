# VoiceCanvas Studio

## Speak a system. See the architecture. Review the risks.

VoiceCanvas Studio is a voice-first workspace for creating and reviewing software architecture and business-process diagrams. A user describes a system in natural language, and the application converts that description into an editable graph of nodes, relationships, and decision paths.

The project is being developed for the AssemblyAI Voice Agent Hackathon 2026.

[![Powered by AssemblyAI](https://img.shields.io/badge/Powered%20by-AssemblyAI-black)](https://www.assemblyai.com/)[![Frontend](https://img.shields.io/badge/Frontend-React-61DAFB)](https://react.dev/)[![Language](https://img.shields.io/badge/Language-TypeScript-3178C6)](https://www.typescriptlang.org/)[![Status](https://img.shields.io/badge/Status-Prototype-orange)](#status)

## Overview

Creating a system diagram usually requires a user to switch between thinking about the design and operating a diagram editor. They must locate shapes, place them on a canvas, label them, connect them, and reorganize the layout. VoiceCanvas is intended to reduce that mechanical work.

The interaction model is:

> **Speak → interpret → update the graph → validate → export**

The result is not an image generated from a prompt. It is structured, editable diagram state. Nodes and edges can be modified, removed, or reverted through subsequent voice commands.

For example, a user can say:

> “Create a food-delivery architecture with login, restaurant search, a cart, payment, order storage, and notifications. If payment fails, add a retry path.”

The application creates the corresponding graph. The user can then say:

> “Add two-factor authentication after login.”

or:

> “Find the likely single points of failure and export this as Mermaid.”

## Why voice

Architecture and process design often begin as spoken explanations. VoiceCanvas allows users to describe a system without first learning the controls of a diagram editor. It is intended for students, developers, product managers, consultants, and small teams reviewing a design together.

Voice is useful here because the user can create and revise a design while thinking aloud. The system must support corrections, follow-up questions, undo operations, and changes to previously created elements. It should not treat each utterance as an isolated request.

## Hackathon context

| Item | Details |
| --- | --- |
| Event | AssemblyAI Voice Agent Hackathon |
| Organizer | lablab.ai and AssemblyAI |
| Dates | September 1–30, 2026 |
| Format | Online |
| Project status | Prototype |

The project uses AssemblyAI’s Voice Agent API for real-time speech interaction, turn detection, voice output, and structured tool calling. The application layer is responsible for maintaining the diagram, validating operations, and presenting the result.

## Core workflow

```
User describes a system
          ↓
AssemblyAI processes the voice interaction
          ↓
The agent identifies the requested graph operation
          ↓
The backend validates and executes the operation
          ↓
The graph is checked for structural issues
          ↓
The canvas displays the updated diagram
          ↓
The user can continue editing or export the result
```

## Scope of the prototype

The prototype focuses on a single, well-defined workflow: creating and reviewing software architecture or business-process diagrams through voice.

The initial version supports the following operations:

- Creating typed nodes such as actors, services, databases, processes, decisions, and external systems.

- Connecting nodes with directed relationships.

- Updating labels and node types.

- Deleting nodes and connections.

- Undoing the most recent graph operation.

- Highlighting structural risks.

- Exporting the graph as PNG, Mermaid, or JSON.

The project does not attempt to replace a professional architecture review. Its validation features are advisory and intended to help users notice obvious structural problems.

## Architecture

```
                    +----------------------+
                    |         User         |
                    |      Microphone      |
                    +----------+-----------+
                               |
                               | Spoken request
                               v
                    +----------------------+
                    |       Frontend       |
                    | React and TypeScript |
                    | Live transcript      |
                    | Diagram canvas       |
                    | Agent status         |
                    +----------+-----------+
                               |
                               | Voice session
                               v
              +------------------------------------+
              |             AssemblyAI              |
              |          Voice Agent API            |
              |                                    |
              | Speech recognition                 |
              | Turn detection                     |
              | LLM interaction                    |
              | Text-to-speech                     |
              | Tool calling                       |
              +----------------+-------------------+
                               |
                               | Structured tool calls
                               v
                    +----------------------+
                    |       Backend        |
                    | Node.js and TypeScript|
                    | Tool validation      |
                    | Graph state          |
                    | History and logging  |
                    +----------+-----------+
                               |
              +----------------+----------------+
              |                |                |
              v                v                v
       +-------------+  +-------------+  +-------------+
       | Graph state |  | Validation  |  |  Export     |
       | Nodes       |  | Connectivity|  | PNG         |
       | Edges       |  | Risk checks |  | Mermaid     |
       | History     |  | Branches    |  | JSON        |
       +-------------+  +-------------+  +-------------+
                               |
                               v
                    +----------------------+
                    |   React Flow canvas  |
                    | Editable graph       |
                    | Risk highlights      |
                    | Export controls      |
                    +----------------------+
```

## Technology stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Voice | AssemblyAI Voice Agent API | Real-time speech interaction and tool calling |
| Frontend | React, TypeScript, Vite | User interface and application state |
| Canvas | React Flow | Interactive node-and-edge rendering |
| Audio | Web Audio API | Browser microphone access and audio handling |
| Backend | Node.js, TypeScript, Fastify or Express | Session coordination and tool execution |
| Validation | JSON Schema or Zod | Tool-parameter and graph-reference validation |
| Hosting | Vercel and a free-tier backend host | Prototype deployment |
| Storage | In-memory state with optional JSON export | MVP persistence model |

## Tool system

The agent does not directly modify the canvas or execute arbitrary code. All diagram changes pass through explicit backend functions.

| Tool | Purpose |
| --- | --- |
| `add_node` | Add a typed node to the current diagram. |
| `connect_nodes` | Create a relationship between two existing nodes. |
| `update_node` | Change a node label, type, or description. |
| `delete_node` | Remove a node and its associated connections. |
| `undo_last_action` | Revert the most recent accepted operation. |
| `highlight_risk` | Mark a node or edge with a validation finding. |
| `export_diagram` | Export the diagram as PNG, Mermaid, or JSON. |

Example tool definition:

```json
{
  "type": "function",
  "name": "add_node",
  "description": "Add a typed node to the current architecture diagram.",
  "parameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "Stable identifier for the node"
      },
      "label": {
        "type": "string",
        "description": "Human-readable node label"
      },
      "node_type": {
        "type": "string",
        "enum": [
          "actor",
          "service",
          "database",
          "process",
          "decision",
          "external"
        ]
      }
    },
    "required": ["id", "label", "node_type"]
  }
}
```

Each operation follows the same sequence:

```
Receive tool request
          ↓
Validate the schema
          ↓
Validate node and edge references
          ↓
Apply the operation
          ↓
Run structural checks
          ↓
Record the operation
          ↓
Return a structured result
          ↓
Update the canvas and voice response
```

If an operation fails, the agent must report the failure accurately. It must not claim that an action succeeded when the backend rejected it.

## Validation

The initial validation layer performs simple, explainable checks:

- Disconnected nodes.

- Edges that refer to missing nodes.

- Decision nodes without meaningful branches.

- Processes with no clear entry or exit path.

- Duplicate identifiers.

- Possible single points of failure based on graph structure.

- Missing retry or fallback paths for selected critical operations.

For example, the application may report:

> “The payment service is connected to checkout and order creation, but there is no retry or fallback path. It has been highlighted for review.”

These findings are suggestions, not guarantees of security, reliability, or production readiness.

## Agent states

The interface exposes the current state of the voice interaction and graph update process.

```
IDLE
  ↓
LISTENING
  ↓
UNDERSTANDING
  ↓
EXECUTING TOOL
  ↓
VALIDATING GRAPH
  ↓
RESPONDING
  ↓
IDLE
```

The application should also handle interruption, cancellation, malformed tool parameters, missing graph references, and temporary connection failures.

## Demonstration scenario

The primary demonstration uses a food-delivery system because it contains familiar services, data stores, decisions, and failure paths.

```
1. “Create a food-delivery architecture.”
2. “Add login and restaurant search.”
3. “Add a cart, payment, order database, and notifications.”
4. “If payment fails, add a retry branch.”
5. “Add two-factor authentication after login.”
6. “Undo the last change.”
7. “Find the likely single points of failure.”
8. “Export this as Mermaid and PNG.”
```

A short presentation should first establish the problem, then show the complete voice interaction, followed by an edit, an undo operation, a validation result, and an export. The live diagram should remain visible throughout the demonstration.

## Getting started

### Prerequisites

- Node.js 18 or later.

- npm, pnpm, or yarn.

- An AssemblyAI API key.

- A modern browser with microphone support.

### Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/voicecanvas.git
cd voicecanvas
```

### Configure the backend

Create a local environment file from the example configuration:

```bash
cp backend/.env.example backend/.env
```

Add the AssemblyAI API key to the backend environment:

```
ASSEMBLYAI_API_KEY=your_assemblyai_api_key
PORT=8000
```

The API key must remain on the server. Do not commit `.env` files, temporary tokens, or credentials to the repository.

### Start the backend

```bash
cd backend
npm install
npm run dev
```

### Start the frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open the local URL printed by the frontend development server and grant microphone permission when prompted.

The commands above are a template for the planned repository structure. They should be updated if the implementation uses different package scripts or directories.

## Suggested repository structure

```
voicecanvas/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Canvas.tsx
│   │   │   ├── TranscriptPanel.tsx
│   │   │   ├── AgentStatus.tsx
│   │   │   └── ValidationPanel.tsx
│   │   ├── graph/
│   │   │   ├── graphTypes.ts
│   │   │   ├── graphStore.ts
│   │   │   └── layout.ts
│   │   └── App.tsx
│   └── package.json
├── backend/
│   ├── src/
│   │   ├── assemblyai/
│   │   ├── tools/
│   │   ├── validation/
│   │   ├── export/
│   │   └── server.ts
│   ├── .env.example
│   └── package.json
├── docs/
│   ├── architecture.md
│   └── demo-script.md
├── .gitignore
├── LICENSE
└── README.md
```

## Testing checklist

Before recording the submission, test the project in a clean browser.

| Area | Test |
| --- | --- |
| Microphone | Permission, mute, refresh, and reconnect behavior |
| Conversation | Short request, long request, correction, and silence |
| Interruption | User interrupts while the agent is speaking |
| Tool calls | Valid parameters, missing references, and duplicate identifiers |
| Graph state | Add, connect, update, delete, and undo |
| Validation | Disconnected node, missing branch, and single-point-of-failure example |
| Export | Readable PNG and valid Mermaid output |
| Failure handling | The application reports failed operations honestly |
| Security | Credentials remain on the backend |
| Demo reliability | A recorded fallback is available if the live service fails |

## Roadmap

### Hackathon prototype

- [ ] AssemblyAI Voice Agent API connection.

- [ ] Live transcript and agent status.

- [ ] Add, connect, update, delete, and undo operations.

- [ ] React Flow canvas with automatic layout.

- [ ] Basic structural validation.

- [ ] Mermaid, PNG, and JSON export.

- [ ] Submission video and presentation materials.

### Future work

- [ ] Saved projects and version history.

- [ ] Diagram diffs between revisions.

- [ ] Import from Mermaid and existing documentation.

- [ ] Architecture templates for web, mobile, data, and event-driven systems.

- [ ] Collaborative workspaces.

- [ ] Integrations with GitHub, Notion, Jira, and documentation platforms.

- [ ] More advanced reliability and security analysis.

## Limitations and responsible use

VoiceCanvas Studio is a prototype. Its graph checks are limited and should not be treated as a complete architecture, security, compliance, or reliability assessment.

Demonstrations should use synthetic examples. Do not upload confidential diagrams, production credentials, personal information, medical records, or customer data. Follow AssemblyAI’s current documentation for authentication, session management, data handling, and billing.

## Team

| Area | Responsibility |
| --- | --- |
| Product and user experience | Define the diagram workflow, examples, and interaction model |
| Voice and agent engineering | Integrate AssemblyAI and implement tool calling |
| Frontend and visualization | Build the canvas, live status, validation panel, and exports |
| Documentation and presentation | Prepare the README, architecture explanation, demo, and submission materials |

## License

This project is intended to use the MIT License unless the team selects a different license before submission.

## References

- [AssemblyAI Voice Agent API](https://www.assemblyai.com/products/voice-agent-api)

- [AssemblyAI Voice Agent API Documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)

- [AssemblyAI Streaming Speech-to-Text Documentation](https://www.assemblyai.com/docs/speech-to-text/streaming)

- [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon)

- [Lablab.ai Hackathon Rule Book](https://lablab.ai/hackathon-rules)

## Status

Prototype under development for the AssemblyAI Voice Agent Hackathon 2026.
