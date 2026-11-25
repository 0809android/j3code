"use strict";

// Adds the Notification Service Extension that opens K3 relay notifications (spec §13). It shares
// the app's keychain group, where the app keeps each host's notification key `Nk`.

const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const TARGET_NAME = "K3RelayNotificationService";
const SOURCE_DIR = path.join(__dirname, "k3relay-notification-service");
const SOURCE_FILES = ["NotificationService.swift"];
const DEPLOYMENT_TARGET = "18.0";

const keychainGroup = (bundleIdentifier) => `$(AppIdentifierPrefix)${bundleIdentifier}`;

function entitlementsPlist(group) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>
    <string>${group}</string>
  </array>
</dict>
</plist>
`;
}

function withExtensionFiles(config, group) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const directory = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME);
      fs.mkdirSync(directory, { recursive: true });
      for (const file of [...SOURCE_FILES, "Info.plist"]) {
        fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(directory, file));
      }
      fs.writeFileSync(
        path.join(directory, `${TARGET_NAME}.entitlements`),
        entitlementsPlist(group),
      );
      return cfg;
    },
  ]);
}

function withExtensionTarget(config, { extensionBundleIdentifier }) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    if (project.pbxTargetByName(TARGET_NAME)) return cfg;
    const objects = project.hash.project.objects;
    // node-xcode's addTarget assumes these sections exist.
    objects.PBXTargetDependency = objects.PBXTargetDependency || {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

    const group = project.addPbxGroup(
      [...SOURCE_FILES, "Info.plist", `${TARGET_NAME}.entitlements`],
      TARGET_NAME,
      TARGET_NAME,
    );
    for (const [key, value] of Object.entries(objects.PBXGroup)) {
      if (typeof value === "object" && value.name === undefined && value.path === undefined) {
        project.addToPbxGroup(group.uuid, key);
      }
    }

    // `app_extension` also embeds the product in the app ("Embed Foundation Extensions").
    const target = project.addTarget(
      TARGET_NAME,
      "app_extension",
      TARGET_NAME,
      extensionBundleIdentifier,
    );
    project.addBuildPhase(SOURCE_FILES, "PBXSourcesBuildPhase", "Sources", target.uuid);
    project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

    const teamId = cfg.ios?.appleTeamId;
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const [key, configuration] of Object.entries(configurations)) {
      if (key.endsWith("_comment") || typeof configuration !== "object") continue;
      const settings = configuration.buildSettings;
      if (!settings || settings.PRODUCT_NAME !== `"${TARGET_NAME}"`) continue;
      Object.assign(settings, {
        CODE_SIGN_ENTITLEMENTS: `${TARGET_NAME}/${TARGET_NAME}.entitlements`,
        CODE_SIGN_STYLE: "Automatic",
        INFOPLIST_FILE: `${TARGET_NAME}/Info.plist`,
        IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
        MARKETING_VERSION: cfg.version ?? "1.0.0",
        CURRENT_PROJECT_VERSION: cfg.ios?.buildNumber ?? "1",
        PRODUCT_BUNDLE_IDENTIFIER: `"${extensionBundleIdentifier}"`,
        SWIFT_VERSION: "5.0",
        TARGETED_DEVICE_FAMILY: `"1,2"`,
        ...(teamId ? { DEVELOPMENT_TEAM: teamId } : {}),
      });
    }
    if (teamId) project.addTargetAttribute("DevelopmentTeam", teamId, target);
    return cfg;
  });
}

/** EAS manages credentials for the extension only when it is declared. */
function withEasAppExtension(config, { extensionBundleIdentifier, group }) {
  const extra = config.extra ?? {};
  const eas = extra.eas ?? {};
  const build = eas.build ?? {};
  const experimental = build.experimental ?? {};
  const ios = experimental.ios ?? {};
  const appExtensions = (ios.appExtensions ?? []).filter(
    (extension) => extension.targetName !== TARGET_NAME,
  );
  appExtensions.push({
    targetName: TARGET_NAME,
    bundleIdentifier: extensionBundleIdentifier,
    entitlements: { "keychain-access-groups": [group] },
  });
  return {
    ...config,
    extra: {
      ...extra,
      eas: {
        ...eas,
        build: { ...build, experimental: { ...experimental, ios: { ...ios, appExtensions } } },
      },
    },
  };
}

module.exports = function withK3RelayNotificationService(config) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) {
    throw new Error("withK3RelayNotificationService needs ios.bundleIdentifier.");
  }
  // The first keychain group of the app is where expo-secure-store writes by default.
  const groups = config.ios?.entitlements?.["keychain-access-groups"] ?? [];
  const group = groups[0] ?? keychainGroup(bundleIdentifier);
  const extensionBundleIdentifier = `${bundleIdentifier}.k3relay-notifications`;
  let next = withEasAppExtension(config, { extensionBundleIdentifier, group });
  next = withExtensionFiles(next, group);
  return withExtensionTarget(next, { extensionBundleIdentifier });
};
