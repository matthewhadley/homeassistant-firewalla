import { SecureUtil, FWGroup, FWGroupApi, HostService } from 'node-firewalla'
import * as fs from 'fs';
import dayjs from "dayjs";
import fetch from "node-fetch";

const FIREWALLA_VERSION = process.env.FIREWALLA_VERSION || 'dev';
const FIREWALLA_IP = process.env.FIREWALLA_IP || "192.168.1.1";
const FIREWALLA_PUBLIC_KEY_STRING = process.env.FIREWALLA_PUBLIC_KEY_STRING;
const FIREWALLA_PRIVATE_KEY_STRING = process.env.FIREWALLA_PRIVATE_KEY_STRING;
const FIREWALLA_INTERVAL = ((parseInt(process.env.FIREWALLA_INTERVAL) || 60) * 1000);
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const DEBUG = process.env.FIREWALLA_DEBUG === "true";
const DEBUG_DISABLE_HA = process.env.FIREWALLA_DISABLE_HA === "true"
const DEBUG_LOCAL_KEYS = process.env.FIREWALLA_LOCAL_KEYS === "true"

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

logger.info(`Firewalla ${FIREWALLA_VERSION}`);

function processHosts(data) {
  return data.hosts.map(host => {
      // Extract and transform properties
      const ip = host.ip || "0.0.0.0";
      const mac = host.mac || null;
      const macVendor = host.macVendor || null;
      const name = host.name || host.dhcpName || host.localDomain || null;

      // Generate id from MAC address
      const id = mac
            ? "network_device_" + mac.replace(/:/g, "").toLowerCase().slice(-6)
            : null;

      // Determine status
      // const status = host.policy?.deviceOffline === false ? "online" : "offline";

      // Extract lastActive and firstFound, flooring the values
      const lastActive = host.lastActive ? Math.floor(host.lastActive) : null;
      const firstFound = host.firstFound ? Math.floor(host.firstFound) : null;

      // Extract ipAllocationType
      const ipAllocationType = host.policy?.ipAllocation?.allocations
          ? Object.values(host.policy.ipAllocation.allocations)[0]?.type || "dynamic"
          : "dynamic";

      return {
          id,
          name,
          ip,
          mac,
          macVendor,
          lastActive,
          firstFound,
          ipAllocationType
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
  // Import public & private key (by file name)
  if (DEBUG_LOCAL_KEYS) {
    SecureUtil.importKeyPair('etp.public.pem', 'etp.private.pem');
  } else {
    logger.debug('keys');
    logger.debug(FIREWALLA_PUBLIC_KEY_STRING);
    logger.debug(FIREWALLA_PRIVATE_KEY_STRING);
    SecureUtil.importKeyPairFromString(FIREWALLA_PUBLIC_KEY_STRING, FIREWALLA_PRIVATE_KEY_STRING);
  }

  let { groups } = await FWGroupApi.login();
  let fwGroup = FWGroup.fromJson(groups[0], FIREWALLA_IP);

  // List all hosts connected to your firewalla
  let hostService = new HostService(fwGroup);
  let hosts = await hostService.getAll();

  let devices = processHosts(hosts);

  logger.info(`${devices.length} devices`);

  if (DEBUG_DISABLE_HA !== true) {
    await updateHA(devices);
  }
}

await queryFirewalla();
setInterval(async function() {
  await queryFirewalla();
}, FIREWALLA_INTERVAL);
