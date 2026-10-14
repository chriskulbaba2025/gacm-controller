import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const expectedTools = [
  "project_status",
  "read_project_file",
  "git_diff",
  "run_codex",
  "codex_status",
  "cancel_codex",
  "notification_status",
  "send_notification"
].sort();

async function main() {
  const client = new Client({ name: "prysm-gacm-mcp-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd()
  });

  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedTools)) {
    throw new Error(`Tool list mismatch: ${JSON.stringify(names)}`);
  }

  const status = await client.callTool({
    name: "project_status",
    arguments: { project: "prysm" }
  });
  if (status.isError) throw new Error("project_status returned an MCP error.");

  const blocked = await client.callTool({
    name: "read_project_file",
    arguments: { project: "prysm", relativePath: "..\\gacm-trial\\README.md" }
  });
  if (!blocked.isError) throw new Error("Path escape did not fail closed over MCP.");

  const notification = await client.callTool({
    name: "notification_status",
    arguments: {}
  });
  if (notification.isError) throw new Error("notification_status returned an MCP error.");

  console.log(JSON.stringify({
    pass: true,
    tools: names,
    projectStatusCallable: true,
    pathEscapeFailsClosed: true,
    notificationStatusCallable: true
  }, null, 2));

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
