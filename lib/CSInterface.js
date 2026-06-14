/**
 * CSInterface.js - Adobe CEP Interface Library (Minimal Version)
 * This is a minimal implementation. For production, use the official version from:
 * https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/CSInterface.js
 */

function CSInterface() { }

/**
 * Evaluates a JavaScript script in ExtendScript.
 */
CSInterface.prototype.evalScript = function (script, callback) {
    if (callback === null || callback === undefined) {
        callback = function (result) { };
    }
    window.__adobe_cep__.evalScript(script, callback);
};

/**
 * Retrieves the path of the extension.
 */
CSInterface.prototype.getSystemPath = function (pathType) {
    var path = window.__adobe_cep__.getSystemPath(pathType);
    return path;
};

/**
 * Opens a URL in the default browser.
 */
CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    cep.util.openURLInDefaultBrowser(url);
};

/**
 * Gets information about the host environment.
 */
CSInterface.prototype.getHostEnvironment = function () {
    var hostEnvironment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    return hostEnvironment;
};

/**
 * Get extension ID
 */
CSInterface.prototype.getExtensionID = function () {
    return window.__adobe_cep__.getExtensionId();
};

/**
 * System path types
 */
var SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
};

/**
 * Color types for theme
 */
CSInterface.prototype.getUITheme = function () {
    return this.getHostEnvironment().appSkinInfo;
};

// Export for Node.js environments
if (typeof module !== 'undefined') {
    module.exports = CSInterface;
}
