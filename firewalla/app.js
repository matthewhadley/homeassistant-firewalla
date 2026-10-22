import {
  SecureUtil,
  FWCmdMessage,
  FWGroup,
  FWGroupApi,
  HostService,
  NetworkService,
} from "node-firewalla";
import dayjs from "dayjs";
import fetch from "node-fetch";
import { readFile, unlink, writeFile } from "node:fs/promises";

const FIREWALLA_VERSION = process.env.FIREWALLA_VERSION || "dev";
const FIREWALLA_IP = process.env.FIREWALLA_IP || "192.168.1.1";
const FIREWALLA_PUBLIC_KEY_STRING = (
  process.env.FIREWALLA_PUBLIC_KEY_STRING || ""
).replace(
  /(?<=-----BEGIN PUBLIC KEY-----)([\s\S]*?)(?=-----END PUBLIC KEY-----)/,
  (match) => match.replace(/\s+/g, "\n"),
);
const FIREWALLA_PRIVATE_KEY_STRING = (
  process.env.FIREWALLA_PRIVATE_KEY_STRING || ""
).replace(
  /(?<=-----BEGIN PRIVATE KEY-----)([\s\S]*?)(?=-----END PRIVATE KEY-----)/,
  (match) => match.replace(/\s+/g, "\n"),
);
const HA_TOKEN = process.env.HA_TOKEN || process.env.FIREWALLA_HA_TOKEN;
const FIREWALLA_INTERVAL =
  (parseInt(process.env.FIREWALLA_INTERVAL) || 60) * 1000;
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const DEBUG_LOCAL = process.env.DEBUG_LOCAL === "true";
const DEBUG = process.env.FIREWALLA_DEBUG === "true";
const HA_URL = process.env.HA_URL || "http://supervisor/core";
const GROUP_PATH = DEBUG_LOCAL ? "group.json" : "/data/group.json";
let knownDevices = {};

function formatMessage(message) {
  if (message instanceof Error) {
    let formatted = message.stack
      .replace(/^Error: /, "")
      .replaceAll("\n    ", " ");
    if (message.cause !== undefined) {
      formatted += ` Caused by: ${formatMessage(message.cause)}`;
    }
    return formatted;
  } else if (typeof message === "object") {
    return JSON.stringify(message);
  } else {
    return message;
  }
}

const logger = function (level, ...messages) {
  let timestamp = dayjs().format("YYYY-MM-DD HH:mm:ss");

  let combinedMessage = messages.map(formatMessage).join(" ");

  console.log(`[${timestamp}] ${level}: ${combinedMessage}`);
};

logger.info = function (...messages) {
  logger("INFO", ...messages);
};
logger.warn = function (...messages) {
  logger("WARN", ...messages);
};
logger.error = function (...messages) {
  logger("ERROR", ...messages);
};
logger.debug = function (...messages) {
  if (DEBUG) {
    logger("DEBUG", ...messages);
  }
};

if (!DEBUG_LOCAL) {
  logger.info(`Firewalla ${FIREWALLA_VERSION}`);
}

let haDeleteBaseUrl;

function normalizeMac(mac) {
  return typeof mac === "string" ? mac.toUpperCase() : null;
}

function formatMac(bytes) {
  return bytes
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
}

function getHostName(host) {
  return host.name || host.bname || host.dhcpName || host.localDomain || null;
}

function buildAccessPointNameByBssid(hosts) {
  return hosts.reduce((accessPoints, host) => {
    if (host.macVendor !== "FIREWALLA INC" || host.staInfo) {
      return accessPoints;
    }

    const name = getHostName(host);
    const mac = normalizeMac(host.mac);
    if (!name || !mac) {
      return accessPoints;
    }

    const bytes = mac.split(":").map((byte) => parseInt(byte, 16));
    if (bytes.length !== 6 || bytes.some((byte) => Number.isNaN(byte))) {
      return accessPoints;
    }

    [2, 3, 4].forEach((offset) => {
      const candidate = [...bytes];
      candidate[5] = (candidate[5] + offset) & 0xff;
      accessPoints[formatMac(candidate)] = name;
    });

    const localAdminCandidate = [...bytes];
    localAdminCandidate[0] = localAdminCandidate[0] ^ 0x06;
    localAdminCandidate[5] = (localAdminCandidate[5] + 4) & 0xff;
    accessPoints[formatMac(localAdminCandidate)] = name;

    return accessPoints;
  }, {});
}

function getStaInfo(host, accessPointNameByBssid = {}) {
  const staInfo = host.StaInfo || host.staInfo || host.stainfo || {};
  const bssid = normalizeMac(staInfo.bssid || staInfo.BSSID);

  return {
    ssid: staInfo.ssid || staInfo.SSID || "-",
    rssi: staInfo.rssi ?? staInfo.RSSI ?? "-",
    bssid: bssid || "-",
    ap: accessPointNameByBssid[bssid] || "-",
  };
}

// Map the MAC of each online device, AP and switch to the Firewalla AP or
// switch it connects through, from the AP controller's tree of the network
// (box, switches, APs, devices). A device wired into an AP's own port has that
// AP.
function buildUplinkByMac(tree) {
  const uplinks = {};
  const visit = (node) => {
    for (const child of node.children || []) {
      const mac = normalizeMac(child.mac);
      if (mac && node.type !== "box") {
        uplinks[mac] = {
          type: node.type,
          name: node.name || node.mac,
          port: child.connectionType === "wired" ? child.parent_port : null,
        };
      }
      visit(child);
    }
  };
  (Array.isArray(tree) ? tree : []).forEach(visit);
  return uplinks;
}

/**
 * Determine the correct Home Assistant Core base URL to use for DELETE calls.
 * As supervisor API does not have a DELETE method for sensors
 *
 * Preference order:
 * 1. If HA_URL is set and is not the supervisor core proxy, use that.
 * 2. Ask the Supervisor for Home Assistant info (ip_address, port) and build a URL.
 * 3. Fall back to http://homeassistant:8123
 */
async function getHaDeleteBaseUrl() {
  // If HA_URL is explicitly set to a non-supervisor URL, use that directly.
  if (process.env.HA_URL && !process.env.HA_URL.includes("supervisor/core")) {
    haDeleteBaseUrl = process.env.HA_URL;
    logger.debug(`Using configured HA_URL for deletes: ${haDeleteBaseUrl}`);
    return haDeleteBaseUrl;
  }

  // Try to discover Core location via Supervisor API
  try {
    const infoResponse = await fetch("http://supervisor/homeassistant/info", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (infoResponse.ok) {
      const info = await infoResponse.json();
      const data = info.data || {};
      const ip = data.ip_address || "homeassistant";
      const port = data.port || 8123;
      haDeleteBaseUrl = `http://${ip}:${port}`;
      logger.debug(
        `Using Home Assistant Core URL for deletes from supervisor info: ${haDeleteBaseUrl}`,
      );
      return haDeleteBaseUrl;
    } else {
      logger.warn(
        "Failed to fetch Home Assistant info from supervisor",
        infoResponse.status,
        infoResponse.statusText,
      );
    }
  } catch (error) {
    logger.warn(
      "Error while fetching Home Assistant info from supervisor",
      error,
    );
  }

  // Fallback if supervisor-based discovery fails
  haDeleteBaseUrl = "http://homeassistant:8123";
  logger.info(
    `Falling back to default Home Assistant Core URL for deletes: ${haDeleteBaseUrl}`,
  );
  return haDeleteBaseUrl;
}

if (!DEBUG_LOCAL) {
  haDeleteBaseUrl = await getHaDeleteBaseUrl();
}

// Return an array of entity_ids for all sensor.firewalla_network_device_* in Home Assistant
async function getHomeAssistantFirewallaNetworkDevices() {
  try {
    const response = await fetch(`${HA_URL}/api/states`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      logger.warn(
        "Failed to fetch Home Assistant states for Firewalla devices",
        response.status,
        response.statusText,
      );
      return [];
    }

    const states = await response.json();

    return states
      .filter(
        (s) =>
          s.entity_id &&
          s.entity_id.startsWith("sensor.firewalla_network_device_"),
      )
      .map((s) => s.entity_id.replace(/^sensor\./, ""));
  } catch (error) {
    logger.error(
      "Error while fetching Home Assistant Firewalla network devices",
      error,
    );
    return [];
  }
}

// Cleanup Firewalla device sensors in Home Assistant.
// If keepEntityIds is empty (or omitted), all Firewalla sensors will be deleted.
// Otherwise, only sensors not in keepEntityIds will be deleted.
async function cleanupFirewallaDevices(keepEntityIds = []) {
  try {
    const haEntityIds = await getHomeAssistantFirewallaNetworkDevices();

    const keepSet = new Set(keepEntityIds);

    const toDelete =
      keepEntityIds.length === 0
        ? haEntityIds
        : haEntityIds.filter((id) => !keepSet.has(id));

    for (const id of toDelete) {
      const deleteResponse = await fetch(
        `${haDeleteBaseUrl}/api/states/sensor.${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${HA_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
      );

      if (!deleteResponse.ok) {
        logger.warn(
          `Failed to delete Firewalla sensor ${id}`,
          deleteResponse.status,
          deleteResponse.statusText,
        );
      } else {
        if (keepEntityIds.length !== 0) {
          logger.info(`Removed device ${knownDevices[id]}`);
          delete knownDevices[id];
        }
      }
    }
  } catch (error) {
    logger.error("Error during Firewalla device cleanup", error);
  }
}

function processHosts(data, uplinkByMac = {}) {
  // console.log(JSON.stringify(data, 0, 2));
  const accessPointNameByBssid = buildAccessPointNameByBssid(data.hosts);

  return data.hosts
    .map((host) => {
      // Extract and transform properties
      const ipRaw =
        host.ip ||
        (host.policy?.ipAllocation?.allocations
          ? Object.values(host.policy.ipAllocation.allocations)[0]?.ipv4
          : null) ||
        null;
      const ip = ipRaw || "-";
      const MAC = host.mac || null;
      const vendor = host.macVendor || null;
      const name = getHostName(host);
      const { ssid, rssi, bssid, ap } = getStaInfo(
        host,
        accessPointNameByBssid,
      );
      const uplink = uplinkByMac[normalizeMac(MAC)];
      if (!ipRaw && !name) {
        return null;
      }

      // Generate id from full MAC address
      const id = MAC
        ? "firewalla_network_device_" + MAC.replace(/:/g, "").toLowerCase()
        : null;

      // Extract lastActive and firstFound, flooring the values
      const state = dayjs(Math.floor(host.lastActive) * 1000).format(
        "YYYY-MM-DDTHH:mm:ss",
      );

      const found = dayjs(Math.floor(host.firstFound) * 1000).format(
        "YYYY-MM-DDTHH:mm:ss",
      );

      // Extract ipAllocationType
      const DHCP = host.policy?.ipAllocation?.allocations
        ? Object.values(host.policy.ipAllocation.allocations)[0]?.type ||
          "dynamic"
        : "dynamic";

      return {
        state,
        id,
        device_class: "timestamp",
        attributes: {
          icon: "mdi:ip-network",
          friendly_name: name,
          ip,
          MAC,
          vendor,
          found,
          DHCP,
          ssid,
          rssi,
          bssid,
          ap: uplink?.type === "ap" ? uplink.name : ap,
          connection: uplink?.name || ap,
          port: uplink?.port || "-",
        },
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Sort by IP address numerically
      const parseIP = (ip) =>
        typeof ip === "string" && ip !== "-"
          ? ip.split(".").map((num) => parseInt(num, 10))
          : null;
      const ipA = parseIP(a.attributes.ip);
      const ipB = parseIP(b.attributes.ip);

      if (!ipA && !ipB) {
        return 0;
      }
      if (!ipA) {
        return 1;
      }
      if (!ipB) {
        return -1;
      }

      for (let i = 0; i < 4; i++) {
        if (ipA[i] !== ipB[i]) {
          return ipA[i] - ipB[i];
        }
      }
      return 0;
    });
}

// Returns null once the sensor is updated, otherwise why it wasn't.
async function updateHA(data) {
  try {
    const response = await fetch(`${HA_URL}/api/states/sensor.${data.id}`, {
      method: "POST",
      body: JSON.stringify(data),
      headers: {
        Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    return response.ok
      ? null
      : `HTTP ${response.status} ${response.statusText}`;
  } catch (error) {
    // The code (ECONNREFUSED) rather than the message, which names each
    // sensor's URL and so would not collapse into one reason below.
    return error.code || error.message;
  }
}

// Update all the sensors and log any failures as one line, since Home
// Assistant being unreachable fails every one of them the same way. Returns
// whether all of them were updated. Running locally, print them instead.
async function updateSensors(sensors) {
  if (DEBUG_LOCAL) {
    console.log(JSON.stringify(sensors, 0, 2));
    return true;
  }

  const failures = (await Promise.all(sensors.map(updateHA))).filter(Boolean);
  if (failures.length) {
    logger.error(
      `Failed to update ${failures.length} of ${sensors.length} sensors in Home Assistant: ${[...new Set(failures)].join(", ")}`,
    );
  }
  return failures.length === 0;
}

let speedTestTimestampLast;

// node-firewalla throws whatever the box or cloud returned, often a bare
// object that logs as {}, so wrap it in an Error naming the call that failed.
async function firewallaCall(description, fn) {
  try {
    return await fn();
  } catch (error) {
    let detail;
    if (error instanceof Error) {
      detail = error.message;
    } else if (
      error &&
      typeof error === "object" &&
      Object.keys(error).length === 0
    ) {
      detail =
        "box rejected the request without details (usually it could not decrypt it, e.g. a key mismatch)";
    } else {
      detail = typeof error === "string" ? error : JSON.stringify(error);
    }
    throw new Error(`Firewalla ${description} failed: ${detail}`, {
      cause: error,
    });
  }
}

// A box that cannot decrypt a request answers with an error that reaches here
// as a plain object with no response code. Anything else (an Error from the
// network, a string while the box starts up, a response carrying a code) says
// nothing about the key.
function isKeyRejection(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    !(error instanceof Error) &&
    !("code" in error)
  );
}

if (DEBUG_LOCAL) {
  SecureUtil.importKeyPair("etp.public.pem", "etp.private.pem");
} else {
  SecureUtil.importKeyPairFromString(
    FIREWALLA_PUBLIC_KEY_STRING,
    FIREWALLA_PRIVATE_KEY_STRING,
  );
}

// The box checks only that a request decrypts with the group key, not the
// cloud login token, so the group from a login is kept in memory and saved to
// GROUP_PATH. The cloud login happens only when there is no usable saved
// group or the box rejects its key, which lets polling carry on through an
// internet outage.
let fwGroup = null;

function groupFromJson(group) {
  const fwGroup = FWGroup.fromJson(group, FIREWALLA_IP);

  // Boxes with the "rekey" feature rotate the group key and only accept
  // messages encrypted with the rotated key, which node-firewalla ignores.
  const rkey = group.symmetricKeys[0].rkey;
  if (rkey) {
    fwGroup.symmetricKeyPlain = SecureUtil.rsaDecrypt(JSON.parse(rkey).key);
  }

  // Decrypt now, so a group that doesn't match the key pair fails here.
  fwGroup.getSymmetricKey();
  return fwGroup;
}

async function loadSavedGroup() {
  let saved;
  try {
    saved = await readFile(GROUP_PATH, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Could not read saved Firewalla login", error);
    }
    return null;
  }

  try {
    return groupFromJson(JSON.parse(saved));
  } catch (error) {
    logger.warn("Saved Firewalla login is unusable", error);
    return null;
  }
}

async function login() {
  const loginResponse = await firewallaCall("login", () => FWGroupApi.login());
  const groups = loginResponse?.groups;
  if (!groups?.length) {
    throw new Error(
      `Firewalla login returned no groups: ${JSON.stringify({ ...loginResponse, access_token: undefined })}`,
    );
  }
  const group = groupFromJson(groups[0]);
  logger.info("Logged in to Firewalla");

  try {
    await writeFile(GROUP_PATH, JSON.stringify(groups[0]), { mode: 0o600 });
  } catch (error) {
    logger.warn("Could not save Firewalla login", error);
  }
  return group;
}

async function getGroup() {
  if (!fwGroup) {
    fwGroup = await loadSavedGroup();
    if (fwGroup) {
      logger.info("Using saved Firewalla login");
    } else {
      fwGroup = await login();
    }
  }
  return fwGroup;
}

async function forgetGroup() {
  fwGroup = null;
  try {
    await unlink(GROUP_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Could not remove saved Firewalla login", error);
    }
  }
}

let uplinkFailing = false;

// Fetch the AP controller's network tree through the box. Devices still update
// without it, falling back to guessing the AP from the BSSID, so a failure is
// logged once rather than every poll.
async function getUplinkByMac(fwGroup) {
  try {
    const status = await firewallaCall("network tree request", () =>
      FWGroupApi.sendMessageToBox(
        fwGroup,
        new FWCmdMessage("fwapc", {
          method: "GET",
          path: "/status/wired_station",
        }),
      ),
    );
    uplinkFailing = false;
    return buildUplinkByMac(status?.info?.tree);
  } catch (error) {
    if (!uplinkFailing) {
      uplinkFailing = true;
      logger.warn(error);
    }
    return {};
  }
}

async function pollFirewalla(fwGroup) {
  let networkService = new NetworkService(fwGroup);
  let speedTest = await firewallaCall("speedtest request", () =>
    networkService.getSpeedtestResults(),
  );

  try {
    let speedTestTimestamp = dayjs(
      Math.floor(speedTest.results[0].timestamp) * 1000,
    ).format("YYYY-MM-DDTHH:mm:ss");
    if (speedTestTimestampLast !== speedTestTimestamp) {
      speedTestTimestampLast = speedTestTimestamp;
      let speedTestUpload = parseFloat(
        speedTest.results[0].result.upload.toFixed(2),
      );
      let speedTestDownload = parseFloat(
        speedTest.results[0].result.download.toFixed(2),
      );

      logger.info(
        `speedTest ${speedTestUpload} Mbit/s up, ${speedTestDownload} Mbit/s down (timestamp ${speedTestTimestamp})`,
      );

      const updated = await updateSensors([
        {
          id: "speedtest_upload",
          state: speedTestUpload,
          attributes: {
            icon: "mdi:speedometer",
            device_class: "data_rate",
            state_class: "measurement",
            friendly_name: "SpeedTest Upload",
            unit_of_measurement: "Mbit/s",
            timestamp: speedTestTimestamp,
          },
        },
        {
          id: "speedtest_download",
          state: speedTestDownload,
          attributes: {
            icon: "mdi:speedometer",
            device_class: "data_rate",
            state_class: "measurement",
            friendly_name: "SpeedTest Download",
            unit_of_measurement: "Mbit/s",
            timestamp: speedTestTimestamp,
          },
        },
      ]);

      // Send the same result again next poll rather than leaving the sensors
      // stale until the next speedtest.
      if (!updated) {
        speedTestTimestampLast = undefined;
      }
    }
  } catch (error) {
    logger.error(error);
  }

  // List all hosts connected to your firewalla
  let hostService = new HostService(fwGroup);
  let hosts = await firewallaCall("hosts request", () => hostService.getAll());

  let devices = processHosts(hosts, await getUplinkByMac(fwGroup));

  if (DEBUG_LOCAL) {
    console.log(JSON.stringify(devices, 0, 2));
    process.exit();
  } else {
    const keepEntityIds = devices.map((d) => d.id).filter((id) => !!id);
    await cleanupFirewallaDevices(keepEntityIds);

    let foundDevice = false;
    devices.forEach((device) => {
      if (!(device.id in knownDevices)) {
        foundDevice = true;
        knownDevices[device.id] = device.attributes.friendly_name;
        logger.info(
          "Found device",
          device.attributes.friendly_name || "Unknown",
        );
      }
    });
    if (foundDevice) {
      logger.info(`${devices.length} devices`);
    }
    await updateSensors(devices);
  }
}

async function queryFirewalla() {
  try {
    await pollFirewalla(await getGroup());
  } catch (error) {
    if (!isKeyRejection(error?.cause)) {
      logger.error(error);
      return;
    }

    logger.warn("Firewalla box rejected the key, logging in again");
    await forgetGroup();
    try {
      await pollFirewalla(await getGroup());
    } catch (retryError) {
      if (isKeyRejection(retryError?.cause)) {
        await forgetGroup();
      }
      logger.error(retryError);
    }
  }
}

await queryFirewalla();
setInterval(async function () {
  await queryFirewalla();
}, FIREWALLA_INTERVAL);
