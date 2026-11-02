import { Globe, Mail, MessageCircle, Send } from "lucide-react";
import type { ChannelName } from "@/lib/chat";

const STYLE: Record<ChannelName, { color: string; Icon: typeof Mail }> = {
  WhatsApp: { color: "var(--ch-whatsapp)", Icon: MessageCircle },
  Telegram: { color: "var(--ch-telegram)", Icon: Send },
  Email: { color: "var(--ch-email)", Icon: Mail },
  Web: { color: "var(--accent)", Icon: Globe },
};

export function ChannelIcon({ channel, size = 14 }: { channel: ChannelName; size?: number }) {
  const { color, Icon } = STYLE[channel];
  return <Icon size={size} style={{ color }} />;
}

export function ChannelBadge({ channel }: { channel: ChannelName }) {
  const { color } = STYLE[channel];
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 33%, transparent)`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
      }}
    >
      <ChannelIcon channel={channel} size={10} /> {channel}
    </span>
  );
}
