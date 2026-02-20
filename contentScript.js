function isYouTube() {
  return (
    location.hostname === "www.youtube.com" ||
    location.hostname === "m.youtube.com" ||
    location.hostname === "youtu.be"
  );
}

function getYouTubeTitle() {
  // New YouTube layout: title often in h1.ytd-watch-metadata
  const h1 =
    document.querySelector("h1.ytd-watch-metadata") ||
    document.querySelector("h1.title") ||
    document.querySelector('h1[class*="title"]');
  const text = (h1?.textContent || "").trim();
  if (text) return text;

  // Fallback: document.title includes " - YouTube"
  const t = (document.title || "").replace(/\s+-\s+YouTube\s*$/i, "").trim();
  return t || "";
}

function getYouTubeCurrentTime() {
  // Try multiple selectors for YouTube video element
  const video =
    document.querySelector("video") ||
    document.querySelector("ytd-player video") ||
    document.querySelector("#movie_player video") ||
    document.querySelector(".html5-main-video");

  if (!video) {
    // Try to find video in iframe (for embedded videos)
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          const iframeVideo = iframeDoc.querySelector("video");
          if (iframeVideo && typeof iframeVideo.currentTime === "number") {
            const time = iframeVideo.currentTime;
            if (!isNaN(time) && time >= 0) return Math.floor(time);
          }
        }
      } catch {
        // Cross-origin iframe, skip
      }
    }
    return null;
  }

  // Get currentTime - works even if paused/stopped
  const currentTime = video.currentTime;
  if (typeof currentTime !== "number" || isNaN(currentTime) || currentTime < 0) {
    return null;
  }

  // Return 0 if video is at the start, otherwise return the time
  return Math.floor(currentTime);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function addTimestampToUrl(url, seconds) {
  try {
    const u = new URL(url);
    u.searchParams.set("t", `${seconds}s`);
    return u.toString();
  } catch {
    return url;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Use async handler to allow for potential delays
  (async () => {
    try {
      if (message?.type === "GET_PAGE_METADATA") {
        const title = isYouTube() ? getYouTubeTitle() : (document.title || "").trim();
        sendResponse({ ok: true, title });
        return;
      }

      if (message?.type === "GET_YOUTUBE_TIMESTAMP") {
        if (!isYouTube()) {
          sendResponse({ ok: false, error: "Not a YouTube page." });
          return;
        }

        // First try to get from video element (works even if paused/stopped)
        let currentTime = getYouTubeCurrentTime();

        // If video element not found, wait a bit and try again (video might still be loading)
        if (currentTime === null) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          currentTime = getYouTubeCurrentTime();
        }

        // Fallback: try to extract from URL if video element still not available
        if (currentTime === null) {
          try {
            const urlParams = new URLSearchParams(window.location.search);
            const tParam = urlParams.get("t");
            if (tParam) {
              // YouTube URL format: t=123 or t=1m23s or t=1h2m3s
              // Parse formats like "123", "1m23s", "1h2m3s"
              let totalSeconds = 0;
              const hourMatch = tParam.match(/(\d+)h/);
              const minMatch = tParam.match(/(\d+)m/);
              const secMatch = tParam.match(/(\d+)s/);
              const numOnly = tParam.match(/^(\d+)$/);

              if (hourMatch) totalSeconds += parseInt(hourMatch[1], 10) * 3600;
              if (minMatch) totalSeconds += parseInt(minMatch[1], 10) * 60;
              if (secMatch) totalSeconds += parseInt(secMatch[1], 10);
              if (numOnly && !hourMatch && !minMatch && !secMatch) {
                // Just a number, assume seconds
                totalSeconds = parseInt(numOnly[1], 10);
              }

              if (totalSeconds > 0) {
                currentTime = totalSeconds;
              }
            }
          } catch {
            // URL parsing failed, continue
          }
        }

        // If still no time, default to 0 (start of video)
        if (currentTime === null || currentTime < 0) {
          currentTime = 0;
        }

        const url = addTimestampToUrl(window.location.href, currentTime);
        const formatted = formatTime(currentTime);
        sendResponse({ ok: true, seconds: currentTime, formatted, url });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type." });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true; // Keep channel open for async response
});

