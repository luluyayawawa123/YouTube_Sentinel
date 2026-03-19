export interface RssVideoEntry {
  videoId: string;
  title: string;
  publishedAt: string;
  url: string;
}

export async function fetchChannelFeed(channelId: string): Promise<RssVideoEntry[]> {
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
  if (!response.ok) {
    throw new Error(`Feed request failed with ${response.status}`);
  }

  const xml = await response.text();
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];

  return entries
    .map((entry) => ({
      videoId: match(entry, /<yt:videoId>(.*?)<\/yt:videoId>/),
      title: match(entry, /<title>([\s\S]*?)<\/title>/),
      publishedAt: match(entry, /<published>(.*?)<\/published>/),
      url: match(entry, /<link rel="alternate" href="(.*?)"/)
    }))
    .filter((item) => item.videoId && item.url);
}

function match(input: string, regex: RegExp): string {
  const hit = input.match(regex);
  return hit?.[1]?.trim() ?? "";
}
