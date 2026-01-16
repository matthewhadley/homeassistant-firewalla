import {
  SecureUtil,
  FWGroup,
  FWGroupApi,
  HostService,
  NetworkService,
} from "node-firewalla";
import dayjs from "dayjs";
import fetch from "node-fetch";

const FIREWALLA_VERSION = process.env.FIREWALLA_VERSION || "dev";
const FIREWALLA_IP = process.env.FIREWALLA_IP || "192.168.1.1";
const FIREWALLA_PUBLIC_KEY_STRING = (
  process.env.FIREWALLA_PUBLIC_KEY_STRING || ""
).replace(
  /(?<=-----BEGIN PUBLIC KEY-----)([\s\S]*?)(?=-----END PUBLIC KEY-----)/,
  (match) => match.replace(/\s+/g, "\n")
);
const FIREWALLA_PRIVATE_KEY_STRING = (
  process.env.FIREWALLA_PRIVATE_KEY_STRING || ""
).replace(
  /(?<=-----BEGIN PRIVATE KEY-----)([\s\S]*?)(?=-----END PRIVATE KEY-----)/,
  (match) => match.replace(/\s+/g, "\n")
);
const HA_TOKEN = process.env.HA_TOKEN || process.env.FIREWALLA_HA_TOKEN;
const FIREWALLA_INTERVAL =
  (parseInt(process.env.FIREWALLA_INTERVAL) || 60) * 1000;
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const DEBUG_LOCAL = process.env.DEBUG_LOCAL === "true";
const DEBUG = process.env.FIREWALLA_DEBUG === "true";
const HA_URL = process.env.HA_URL || "http://supervisor/core";
let knownDevices = {};

const logger = function (level, ...messages) {
  let timestamp = dayjs().format("YYYY-MM-DD HH:mm:ss");

  let combinedMessage = messages
    .map((message) => {
      if (message instanceof Error) {
        return message.stack.replace("Error: ", "").replaceAll("\n    ", " ");
      } else if (typeof message === "object") {
        return JSON.stringify(message);
      } else {
        return message;
      }
    })
    .join(" ");

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
        `Using Home Assistant Core URL for deletes from supervisor info: ${haDeleteBaseUrl}`
      );
      return haDeleteBaseUrl;
    } else {
      logger.warn(
        "Failed to fetch Home Assistant info from supervisor",
        infoResponse.status,
        infoResponse.statusText
      );
    }
  } catch (error) {
    logger.warn(
      "Error while fetching Home Assistant info from supervisor",
      error
    );
  }

  // Fallback if supervisor-based discovery fails
  haDeleteBaseUrl = "http://homeassistant:8123";
  logger.info(
    `Falling back to default Home Assistant Core URL for deletes: ${haDeleteBaseUrl}`
  );
  return haDeleteBaseUrl;
}

haDeleteBaseUrl = await getHaDeleteBaseUrl();

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
        response.statusText
      );
      return [];
    }

    const states = await response.json();

    return states
      .filter(
        (s) =>
          s.entity_id &&
          s.entity_id.startsWith("sensor.firewalla_network_device_")
      )
      .map((s) => s.entity_id.replace(/^sensor\./, ""));
  } catch (error) {
    logger.error(
      "Error while fetching Home Assistant Firewalla network devices",
      error
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
        }
      );

      if (!deleteResponse.ok) {
        logger.warn(
          `Failed to delete Firewalla sensor ${id}`,
          deleteResponse.status,
          deleteResponse.statusText
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

function processHosts(data) {
  // console.log(JSON.stringify(data, 0, 2));
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
      const name = host.name || host.dhcpName || host.localDomain || null;
      if (!ipRaw && !name) {
        return null;
      }

      // Generate id from MAC address
      const id = MAC
        ? "firewalla_network_device_" +
          MAC.replace(/:/g, "").toLowerCase().slice(-6)
        : null;

      // Extract lastActive and firstFound, flooring the values
      const state = dayjs(Math.floor(host.lastActive) * 1000).format(
        "YYYY-MM-DDTHH:mm:ss"
      );

      const found = dayjs(Math.floor(host.firstFound) * 1000).format(
        "YYYY-MM-DDTHH:mm:ss"
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
  } catch (error) {
    console.log(error);
  }
}

let speedTestTimestampLast;

async function queryFirewalla() {
  try {
    if (DEBUG_LOCAL) {
      SecureUtil.importKeyPair("etp.public.pem", "etp.private.pem");
    } else {
      SecureUtil.importKeyPairFromString(
        FIREWALLA_PUBLIC_KEY_STRING,
        FIREWALLA_PRIVATE_KEY_STRING
      );
    }

    let { groups } = await FWGroupApi.login();
    let fwGroup = FWGroup.fromJson(groups[0], FIREWALLA_IP);

    let networkService = new NetworkService(fwGroup);
    let speedTest = await networkService.getSpeedtestResults();

    try {
      let speedTestTimestamp = dayjs(
        Math.floor(speedTest.results[0].timestamp) * 1000
      ).format("YYYY-MM-DDTHH:mm:ss");
      if (speedTestTimestampLast !== speedTestTimestamp) {
        speedTestTimestampLast = speedTestTimestamp;
        let speedTestUpload = parseFloat(
          speedTest.results[0].result.upload.toFixed(2)
        );
        let speedTestDownload = parseFloat(
          speedTest.results[0].result.download.toFixed(2)
        );

        logger.info(
          `speedTest ${speedTestUpload} Mbit/s up, ${speedTestDownload} Mbit/s down (timestamp ${speedTestTimestamp})`
        );

        await updateHA({
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
        });

        await updateHA({
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
        });
      }
    } catch (error) {
      logger.error(error);
    }

    // List all hosts connected to your firewalla
    let hostService = new HostService(fwGroup);
    let hosts = await hostService.getAll();

    let devices = processHosts(hosts);

    const keepEntityIds = devices.map((d) => d.id).filter((id) => !!id);
    await cleanupFirewallaDevices(keepEntityIds);

    if (DEBUG_LOCAL) {
      console.log(JSON.stringify(devices, 0, 2));
      process.exit();
    } else {
      let foundDevice = false;
      devices.forEach(async (device) => {
        if (!(device.id in knownDevices)) {
          foundDevice = true;
          knownDevices[device.id] = device.attributes.friendly_name;
          logger.info(
            "Found device",
            device.attributes.friendly_name || "Unknown"
          );
        }
        await updateHA(device);
      });
      if (foundDevice) {
        logger.info(`${devices.length} devices`);
      }
    }
  } catch (error) {
    logger.error(error);
  }
}

await queryFirewalla();
setInterval(async function () {
  await queryFirewalla();
}, FIREWALLA_INTERVAL);
