const fs = require("fs");
const path = require("path");
const req = require("request");
const request = require("request-promise-native");
const skillshareUrl = "https://www.skillshare.com";

const sessionCookie = request.cookie(`PHPSESSID=${process.argv[2]}`);
const classUrl = process.argv[3];
const basePath = path.resolve(process.argv[4] || __dirname);
const jar = request.jar();

jar.setCookie(skillshareUrl, sessionCookie);

const cleanName = name =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .replace(/ /gi, "_");

async function getVideoInfo(accountId, policyKey, session) {
  const match = session.video_mid_thumbnail_url.match(/\/thumbnails\/(\d+)\//);
  if (!match && !session.videoId) {
    console.log("No videoId for ", session);
    return null;
  }
  const videoId = match ? match[1] : session.videoId.split(":")[1];
  const url = `https://edge.api.brightcove.com/playback/v1/accounts/${accountId}/videos/${videoId}`;
  const response = await request(url, {
    headers: { Accept: "application/json;pk=" + policyKey }
  });
  return JSON.parse(response);
}

async function getPolicyKey(skillshareResponse) {
  const [url] = skillshareResponse
    .toString()
    .match(/players\.brightcove\.net\/[^"]+\/index\.min\.js/);
  const response = await request("https://" + url);
  const [, policyKey] = response.toString().match(/policyKey:"([^"]+)"/);
  return policyKey;
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    req(url)
      .pipe(fs.createWriteStream(file))
      .on("finish", resolve);
  });
}

(async () => {
  console.log("Fetching base content...");
  const skillshareResponse = await request(classUrl, { jar });
  console.log("Fetching policy key...");
  const policyKey = await getPolicyKey(skillshareResponse);

  const skillshare = JSON.parse(
    skillshareResponse.toString().match(/SS\.serverBootstrap = (.+);\n/)[1]
  );
  const {
    brightcoveAccountId,
    shareLinks
  } = skillshare.pageData.videoPlayerData;
  const { sessions } = skillshare.pageData.videoPlayerData.units[0];
  const { classTitle } = shareLinks;

  const folderName = cleanName(classTitle);

  if (!fs.existsSync(folderName)) fs.mkdirSync(folderName);

  console.log("Downloading video info...");
  const videoInfos = (await Promise.all(
    sessions.map(session =>
      getVideoInfo(brightcoveAccountId, policyKey, session)
    )
  )).filter(Boolean);

  for (let sessionId in sessions) {
    const session = sessions[sessionId];
    const filename = path.join(
      folderName,
      session.rank + 1 + " - " + cleanName(session.title) + ".mp4"
    );
    if (fs.existsSync(filename)) {
      console.log(`Skipping '${cleanName(session.title)}'.`);
      continue;
    }

    const videoInfo = videoInfos[sessionId];

    if (!videoInfo) {
      console.log(`No sources for '${cleanName(session.title)}', skipping.`);
      continue;
    }

    const videoUrl = videoInfo.sources
      .filter(
        source =>
          (source.src || "").startsWith("https") && source.container === "MP4"
      )
      .sort((a, b) => b.avg_bitrate - a.avg_bitrate)[0].src;

    console.log(`Downloading video to ${filename}...`);
    await download(videoUrl, filename);
    console.log(`Saved video '${filename}'!`);
  }
})();
