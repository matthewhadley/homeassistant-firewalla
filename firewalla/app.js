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
const DEBUG_LOCAL = process.env.FIREWALLA_DEBUG_LOCAL === "true"
const DEBUG = process.env.FIREWALLA_DEBUG === "true";

const logger = function (level, message) {
  let timestamp = dayjs().format("YYYY-MM-DD HH:mm:ss");
  console.log(`[${timestamp}] ${level}: ${message}`);
};
logger.info = function (message) {
  logger("INFO", message);
};
logger.warn = function (message) {
  logger("WARN", message);
};
logger.error = function (message) {
  logger("ERROR", message);
};
logger.debug = function (message) {
  if (DEBUG) {
    logger("DEBUG", message);
  }
};

if (!DEBUG_LOCAL) {
  logger.info(`Firewalla ${FIREWALLA_VERSION}`);
}

function processHosts(data) {
  return data.hosts.map(host => {
      // Extract and transform properties
      const ip = host.ip ||
      (host.policy?.ipAllocation?.allocations
          ? Object.values(host.policy.ipAllocation.allocations)[0]?.ipv4
          : null) ||
      "0.0.0.0";
      const mac = (host.mac || null).replaceAll(':','');
      const vendor = host.macVendor || null;
      const name = host.name || host.dhcpName || host.localDomain || null;

      // Generate id from MAC address
      // const id = mac
      //       ? "network_device_" + mac.replace(/:/g, "").toLowerCase().slice(-6)
      //       : null;

      // Determine status
      // const status = host.policy?.deviceOffline === false ? "online" : "offline";

      // Extract lastActive and firstFound, flooring the values
      const lastActive = host.lastActive ? Math.floor(host.lastActive) : null;
      const firstFound = host.firstFound ? Math.floor(host.firstFound) : null;

      // Extract ipAllocationType
      let ipAllocationType = host.policy?.ipAllocation?.allocations
          ? Object.values(host.policy.ipAllocation.allocations)[0]?.type || "dynamic"
          : "dynamic";

      if (ipAllocationType === 'static') {
        ipAllocationType = 's';
      } else {
        ipAllocationType = 'd';
      }

      return {
          // id,
          n: name,
          ip,
          m: mac,
          v: vendor,
          a: lastActive,
          f: firstFound,
          t: ipAllocationType
      };
  }).sort((a, b) => {
      // Sort by IP address numerically
      const parseIP = ip => ip.split(".").map(num => parseInt(num, 10));
      const ipA = parseIP(a.ip);
      const ipB = parseIP(b.ip);

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
        "http://supervisor/core/api/states/sensor.firewalla_devices",
        {
          method: "POST",
          body: JSON.stringify({
            state: data.length,
            attributes: {
              friendly_name: "Firewalla Devices",
              icon: "mdi:wifi",
              devices: data
            },
          }),
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

  if (DEBUG_LOCAL) {
    let data = {
      hosts: hosts,
      devices: devices
    }
    console.log(JSON.stringify(data, 0, 2));
    process.exit(0);
  } else {
    logger.info(`${devices.length} devices`);
    await updateHA(devices);
  }
}

await queryFirewalla();
setInterval(async function() {
  await queryFirewalla();
}, FIREWALLA_INTERVAL);
