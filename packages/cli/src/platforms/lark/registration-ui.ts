import qrcode from "qrcode-terminal";
import { registerLarkPersonalAgent, type RegisteredLarkPersonalAgent } from "@opentag/lark";
import type { CliLanguage } from "../../catalogs/languages.js";

export type ScanLarkPersonalAgentDependencies = {
  output?: Pick<NodeJS.WriteStream, "write">;
  register?: typeof registerLarkPersonalAgent;
  showQrCode?: boolean;
};

export async function scanLarkPersonalAgent(
  input: { language?: CliLanguage } = {},
  dependencies: ScanLarkPersonalAgentDependencies = {}
): Promise<RegisteredLarkPersonalAgent> {
  const output = dependencies.output ?? process.stdout;
  const register = dependencies.register ?? registerLarkPersonalAgent;
  const showQrCode = dependencies.showQrCode ?? process.env.OPENTAG_SHOW_QR === "1";
  const language = input.language ?? "en";

  const registered = await register({
    onQrCode(info) {
      output.write(
        language === "zh-CN"
          ? "\n打开这个链接创建 Lark/飞书个人代理应用：\n"
          : "\nOpen this URL to create the Lark / Feishu Personal Agent app:\n"
      );
      output.write(`URL: ${info.url}\n`);
      output.write(
        language === "zh-CN"
          ? `二维码约 ${Math.ceil(info.expireIn / 60)} 分钟后过期。\n`
          : `This QR code expires in about ${Math.ceil(info.expireIn / 60)} minute(s).\n`
      );
      if (showQrCode) {
        output.write(language === "zh-CN" ? "\n终端二维码：\n" : "\nTerminal QR code:\n");
        qrcode.generate(info.url, { small: true }, (qr) => {
          output.write(`${qr}\n`);
        });
      } else {
        output.write(
          language === "zh-CN"
            ? "设置链接较长，默认不在终端显示二维码。\n"
            : "Terminal QR codes are hidden by default because setup links are large.\n"
        );
        output.write(
          language === "zh-CN"
            ? "如果想扫描终端二维码，可以设置 OPENTAG_SHOW_QR=1。\n"
            : "Set OPENTAG_SHOW_QR=1 if you prefer scanning a terminal QR code.\n"
        );
      }
      output.write(
        language === "zh-CN"
          ? "这个链接可能从飞书 bootstrap 页面开始；如果你使用 Lark 国际租户，平台会在扫码后切换。请保持这个终端打开，OpenTag 会保存平台返回的真实 Lark/飞书租户。\n\n"
          : "This link may start on the Feishu bootstrap page; Lark global tenants can switch after scan. Keep this terminal open. OpenTag will save the real Lark / Feishu tenant returned by the platform.\n\n"
      );
    },
    onStatus(info) {
      if (info.status === "slow_down") {
        output.write(
          language === "zh-CN"
            ? `Lark 要求降低轮询频率，下次检查将在 ${info.interval ?? "几"} 秒后进行。\n`
            : `Lark asked OpenTag to poll more slowly. Next check in ${info.interval ?? "a few"} seconds.\n`
        );
      } else if (info.status === "domain_switched") {
        output.write(
          language === "zh-CN"
            ? "检测到 Lark 租户，将继续使用 larksuite.com 完成注册。\n"
            : "Detected a Lark tenant. Continuing registration on larksuite.com.\n"
        );
      }
    },
    onWarning(message) {
      output.write(`${message}\n`);
    }
  });

  output.write(language === "zh-CN" ? "Lark 个人代理应用已连接。\n" : "Lark Personal Agent connected.\n");
  output.write(`App ID: ${registered.appId}\n`);
  output.write(`${language === "zh-CN" ? "租户" : "Tenant"}: ${registered.domain}\n`);
  if (registered.operatorOpenId) {
    output.write(`${language === "zh-CN" ? "设置用户" : "Setup user"}: ${registered.operatorOpenId}\n`);
  }
  if (registered.botOpenId) {
    output.write(`${language === "zh-CN" ? "机器人" : "Bot"}: ${registered.botName ?? "OpenTag"} (${registered.botOpenId})\n`);
  }
  output.write("\n");

  return registered;
}
