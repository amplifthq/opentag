import qrcode from "qrcode-terminal";
import { registerLarkPersonalAgent, type LarkDomain, type RegisteredLarkPersonalAgent } from "@opentag/lark";

export type ScanLarkPersonalAgentDependencies = {
  output?: Pick<NodeJS.WriteStream, "write">;
  register?: typeof registerLarkPersonalAgent;
  showQrCode?: boolean;
};

export async function scanLarkPersonalAgent(
  input: { domain: LarkDomain },
  dependencies: ScanLarkPersonalAgentDependencies = {}
): Promise<RegisteredLarkPersonalAgent> {
  const output = dependencies.output ?? process.stdout;
  const register = dependencies.register ?? registerLarkPersonalAgent;
  const showQrCode = dependencies.showQrCode ?? process.env.OPENTAG_SHOW_QR === "1";

  const registered = await register({
    domain: input.domain,
    onQrCode(info) {
      output.write("\nOpen this URL to create the Lark / Feishu Personal Agent app:\n");
      output.write(`URL: ${info.url}\n`);
      output.write(`This QR code expires in about ${Math.ceil(info.expireIn / 60)} minute(s).\n`);
      if (showQrCode) {
        output.write("\nTerminal QR code:\n");
        qrcode.generate(info.url, { small: true }, (qr) => {
          output.write(`${qr}\n`);
        });
      } else {
        output.write("Terminal QR codes are hidden by default because Lark setup links are large.\n");
        output.write("Set OPENTAG_SHOW_QR=1 if you prefer scanning a terminal QR code.\n");
      }
      output.write("Keep this terminal open. OpenTag will continue automatically after the app is created.\n\n");
    },
    onStatus(info) {
      if (info.status === "slow_down") {
        output.write(`Lark asked OpenTag to poll more slowly. Next check in ${info.interval ?? "a few"} seconds.\n`);
      } else if (info.status === "domain_switched") {
        output.write("Detected a Lark tenant. Continuing registration on larksuite.com.\n");
      }
    },
    onWarning(message) {
      output.write(`${message}\n`);
    }
  });

  output.write("Lark Personal Agent connected.\n");
  output.write(`App ID: ${registered.appId}\n`);
  output.write(`Domain: ${registered.domain}\n`);
  if (registered.operatorOpenId) {
    output.write(`Setup user: ${registered.operatorOpenId}\n`);
  }
  if (registered.botOpenId) {
    output.write(`Bot: ${registered.botName ?? "OpenTag"} (${registered.botOpenId})\n`);
  }
  output.write("\n");

  return registered;
}
