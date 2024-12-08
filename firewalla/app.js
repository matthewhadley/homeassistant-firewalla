import { SecureUtil, FWGroup, FWGroupApi, HostService } from 'node-firewalla'
import dayjs from "dayjs";
import fetch from "node-fetch";

const FIREWALLA_VERSION = process.env.FIREWALLA_VERSION || 'dev';
const FIREWALLA_IP = process.env.FIREWALLA_IP || "192.168.1.1";
const FIREWALLA_PUBLIC_KEY_STRING = (process.env.FIREWALLA_PUBLIC_KEY_STRING || '').replace(
  /(?<=-----BEGIN PUBLIC KEY-----)([\s\S]*?)(?=-----END PUBLIC KEY-----)/,
  match => match.replace(/\s+/g, '\n')
);
const FIREWALLA_PRIVATE_KEY_STRING = (process.env.FIREWALLA_PRIVATE_KEY_STRING || '').replace(
  /(?<=-----BEGIN PRIVATE KEY-----)([\s\S]*?)(?=-----END PRIVATE KEY-----)/,
  match => match.replace(/\s+/g, '\n')
);
const FIREWALLA_INTERVAL = ((parseInt(process.env.FIREWALLA_INTERVAL) || 60) * 1000);
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const DEBUG_LOCAL = process.env.DEBUG_LOCAL === "true"
const DEBUG_DUMP = process.env.DEBUG_DUMP === "true"
const DEBUG = process.env.FIREWALLA_DEBUG === "true";

const HA_URL = process.env.HA_URL || "http://supervisor/core";

const logger = function (level, ...messages) {
  let timestamp = dayjs().format("YYYY-MM-DD HH:mm:ss");

  let combinedMessage = messages
    .map(message => (typeof message === "object" ? JSON.stringify(message) : message))
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

if (!DEBUG_DUMP) {
  logger.info(`Firewalla ${FIREWALLA_VERSION}`);
}

function processHosts(data) {
  return data.hosts.map(host => {
      // Extract and transform properties
      const ip = host.ip ||
      (host.policy?.ipAllocation?.allocations
          ? Object.values(host.policy.ipAllocation.allocations)[0]?.ipv4
          : null) ||
      "-";
      const MAC = host.mac || null;
      const vendor = host.macVendor || null;
      const name = host.name || host.dhcpName || host.localDomain || null;

      // Generate id from MAC address
      const id = MAC
            ? "firewalla_network_device_" + MAC.replace(/:/g, "").toLowerCase().slice(-6)
            : null;

      // Extract lastActive and firstFound, flooring the values
      const state = dayjs((Math.floor(host.lastActive) * 1000)).format('YYYY-MM-DDTHH:mm:ss');


      const found = dayjs((Math.floor(host.firstFound) * 1000)).format('YYYY-MM-DDTHH:mm:ss');

      // Extract ipAllocationType
      const DHCP = host.policy?.ipAllocation?.allocations
          ? Object.values(host.policy.ipAllocation.allocations)[0]?.type || "dynamic"
          : "dynamic";


      return {
          state,
          id,
          device_class: "timestamp",
          attributes: {
            icon: 'mdi:ip-network',
            friendly_name: name,
            ip,
            MAC,
            vendor,
            found,
            DHCP
          }
      };
  }).sort((a, b) => {
      // Sort by IP address numerically
      const parseIP = ip => ip.split(".").map(num => parseInt(num, 10));
      const ipA = parseIP(a.attributes.ip);
      const ipB = parseIP(b.attributes.ip);

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
    const response = await fetch(
      `${HA_URL}/api/states/sensor.${data.id}`,
      {
        method: "POST",
        body: JSON.stringify(data),
        headers: {
          Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.log(error);
  }
}

async function queryFirewalla() {
  try {
    if (DEBUG_LOCAL) {
      SecureUtil.importKeyPair('etp.public.pem', 'etp.private.pem');
    } else {
      SecureUtil.importKeyPairFromString(FIREWALLA_PUBLIC_KEY_STRING, FIREWALLA_PRIVATE_KEY_STRING);
    }

    let { groups } = await FWGroupApi.login();
    let fwGroup = FWGroup.fromJson(groups[0], FIREWALLA_IP);

    // List all hosts connected to your firewalla
    let hostService = new HostService(fwGroup);
    let hosts = await hostService.getAll();

    let devices = processHosts(hosts);

    if (DEBUG_DUMP) {
      console.log(JSON.stringify(devices, 0, 2));
      process.exit();
    } else {
      logger.info(`${devices.length} devices`);
      devices.forEach(async device => {
        await updateHA(device);
      });
    }
  } catch (error) {
    logger.error(error);
  }
}

await queryFirewalla();
setInterval(async function() {
  await queryFirewalla();
}, FIREWALLA_INTERVAL);
