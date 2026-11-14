<<<<<<< HEAD
# COLLECT-UI-MCP-SERVER
=======
<div align="center">

# 🎨 Collect UI MCP

### *Your AI assistant's personal UI component library*

**Collect · Search · Recall — every snippet, right inside your editor.**

<br/>

[![npm](https://img.shields.io/npm/v/collect-ui-mcp?style=for-the-badge&logo=npm&color=CB3837)](https://www.npmjs.com/package/collect-ui-mcp)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?style=for-the-badge&logo=anthropic)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![PRs](https://img.shields.io/badge/PRs-Welcome-brightgreen?style=for-the-badge)](CONTRIBUTING.md)

<br/>

[**Quick Start**](#-quick-start) · [**Features**](#-features) · [**Tools**](#-available-tools) · [**Examples**](#-example-usage) · [**Contributing**](#-contributing)

</div>

---

<div align="center">

### 🧠 *Stop scrolling bookmarks. Start asking.*

> **You:** *"Save this button as `neon-button`, tag it `tailwind` and `dark`."*
>
> **Assistant:** *✅ Collected — 24 lines saved to your library.*

</div>

---

## ✨ Why Collect UI MCP?

<table>
<tr>
<td width="50%" valign="top">

### 😩 The old way

- 🔖 47 bookmarks named *"cool button"*
- 📁 A folder called `snippets-final-v2-USE-THIS`
- 🧠 You *know* you saved that card somewhere…
- 📋 Copy-pasting from chat → files → chat → files

</td>
<td width="50%" valign="top">

### ✨ The new way

- 🗣️ Ask your AI to **save**, **find**, or **fetch** components
- 🏷️ Tag by framework, mood, or use-case
- 🔍 Full-text search across your whole library
- 💾 Everything stays **local** and **git-friendly**

</td>
</tr>
</table>

---

## 🎯 Features

<div align="center">

|  | Feature | Description |
|:-:|:--------|:------------|
| 🗂️ | **Collect** | Save any UI snippet with a name, tags & description |
| 🔍 | **Search** | Find components by keyword, tag, or framework |
| 🏷️ | **Organize** | Tag by stack — React, Vue, Tailwind, CSS… |
| 🧾 | **Retrieve** | Pull full source code straight into chat |
| ✏️ | **Update** | Modify existing entries without leaving your editor |
| 🗑️ | **Delete** | Clean up entries in seconds |
| 💾 | **Local-first** | Nothing leaves your machine. Ever. |
| 🧩 | **Framework-agnostic** | Works with any UI stack you throw at it |
| ⚡ | **Zero-config** | Point at a folder. Done. |

</div>

---

## 🚀 Quick Start

<div align="center">

### **3 steps to a smarter UI library**

`Install` → `Configure` → `Ask`

</div>

<br/>

### 1️⃣ &nbsp; Install

```bash
# Global install
npm install -g collect-ui-mcp

# Or use on the fly
npx collect-ui-mcp
```

### 2️⃣ &nbsp; Configure your MCP client

<details open>
<summary><b>🟣 Claude Desktop</b></summary>

<br/>

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "collect-ui": {
      "command": "npx",
      "args": ["-y", "collect-ui-mcp"],
      "env": {
        "COLLECT_UI_DIR": "/absolute/path/to/your/ui-library"
      }
    }
  }
}
```

</details>

<details>
<summary><b>🖱️ Cursor</b></summary>

<br/>

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "collect-ui": {
      "command": "npx",
      "args": ["-y", "collect-ui-mcp"],
      "env": { "COLLECT_UI_DIR": "/absolute/path/to/your/ui-library" }
    }
  }
}
```

</details>

<details>
<summary><b>💻 VS Code (Continue / Cline)</b></summary>

<br/>

```json
{
  "mcpServers": {
    "collect-ui": {
      "command": "npx",
      "args": ["-y", "collect-ui-mcp"],
      "env": { "COLLECT_UI_DIR": "${workspaceFolder}/.ui-library" }
    }
  }
}
```

</details>

### 3️⃣ &nbsp; Restart your client

> 🎉 **Done.** Your AI assistant now has the `collect-ui` toolset.

---

## 🛠️ Available Tools

<div align="center">

| &nbsp; | Tool | Description |
|:------:|:-----|:------------|
| 📥 | `collect_component` | Save a UI snippet with name, code, tags & description |
| 📋 | `list_components` | List all components — filterable by tag |
| 🔍 | `search_components` | Full-text search across names, tags, descriptions |
| 📤 | `get_component` | Fetch the full source + metadata of a component |
| ✏️ | `update_component` | Modify an existing entry |
| 🗑️ | `delete_component` | Remove a component from your library |
| 🏷️ | `list_tags` | See every tag currently in use |

</div>

### 📚 Resources

| URI | Description |
|:----|:------------|
| `collect-ui://library` | Your entire catalog as JSON |
| `collect-ui://component/{name}` | A single component by name |

### 💬 Prompts

- **`find-ui-component`** — Ask the AI for the best match to a design need
- **`summarize-library`** — Get a quick overview of what you've collected

---

## 💡 Example Usage

<details open>
<summary><b>💾 Saving a component</b></summary>

```
You   →  Save this Hero section as "gradient-hero",
         tagged react, tailwind, marketing.

AI    →  ✅ Collected "gradient-hero" (React · Tailwind)
         Saved 42 lines to your library.
```

</details>

<details>
<summary><b>🔍 Searching your library</b></summary>

```
You   →  What button variants do I have collected?

AI    →  You have 3:
         • neon-button   — Tailwind · dark mode glow
         • ghost-button  — CSS · minimal outline
         • pill-button   — React · styled-components
```

</details>

<details>
<summary><b>📤 Retrieving a component</b></summary>

```
You   →  Show me the source of "neon-button".

AI    →  [renders full code from your library]
```

</details>

---

## 🗃️ How Data is Stored

Everything lives in a **single folder you control**:

```text
my-ui-library/
├── neon-button/
│   ├── component.tsx
│   └── meta.json          ← name, tags, description, timestamps
├── gradient-hero/
│   ├── component.tsx
│   └── meta.json
└── .collect-ui-index.json
```

<div align="center">

| ✅ Human-readable | ✅ Git-friendly | ✅ No database | ✅ Yours forever |
|:---:|:---:|:---:|:---:|

</div>

---

## ⚙️ Configuration

| Env var | Default | Description |
|:--------|:--------|:------------|
| `COLLECT_UI_DIR` | `./.ui-library` | Where components are stored |
| `COLLECT_UI_INDEX` | `.collect-ui-index.json` | Index filename |
| `COLLECT_UI_LOG` | `info` | Log level — `debug` · `info` · `warn` · `error` |

---

## 🧪 Development

```bash
# Clone
git clone https://github.com/<your-username>/collect-ui-mcp.git
cd collect-ui-mcp

# Install & build
npm install
npm run build

# Watch mode
npm run dev

# Test
npm test
```

### 🔬 Debug with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## 🗺️ Roadmap

- [ ] ☁️ Cloud sync — S3 / WebDAV
- [ ] 🖼️ Image & screenshot attachments
- [ ] 🧠 Framework-aware imports
- [ ] 🎨 Figma plugin bridge
- [ ] 📊 Web dashboard

> 💡 Have an idea? [Open an issue](https://github.com/<your-username>/collect-ui-mcp/issues) — PRs are welcome!

---

## 🤝 Contributing

<div align="center">

**Every contribution counts — bugs, docs, ideas, code.**

</div>

```bash
# 1. Fork the repo, then:
git checkout -b feat/my-feature
git commit -m "feat: add my feature"
git push origin feat/my-feature
# 2. Open a Pull Request 🚀
```

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) before getting started.

---

## 🙏 Acknowledgements

- 🧬 **[Model Context Protocol](https://modelcontextprotocol.io)** — the spec that makes this possible
- 🏢 **[Anthropic](https://anthropic.com)** — for building and open-sourcing MCP
- 🫡 Everyone who has a folder called `snippets-final-v3-USE-THIS-ONE`

---

## 📄 License

<div align="center">

**[MIT](LICENSE)** © `<Your Name>`

<br/>

⭐ **If this saved you a bookmark, star the repo!**

<sub>Made with ❤️ and a mild obsession with clean components.</sub>

</div>
>>>>>>> 6995874 (Initial commit)
