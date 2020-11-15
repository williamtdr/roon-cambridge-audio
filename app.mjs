"use strict";

import AzurProtocol from './azur-protocol.mjs';
import RoonApi from 'node-roon-api';
import RoonApiSettings from 'node-roon-api-settings';
import RoonApiStatus from 'node-roon-api-status';
import RoonApiVolumeControl from 'node-roon-api-volume-control';
import RoonApiSourceControl from 'node-roon-api-source-control';
import constants from './constants.mjs';
import DynamicLcd from './dynamic-lcd.mjs';

const roon = new RoonApi({
    extension_id: 'moe.tdr.840av2control',
    display_name: `${constants.deviceName} Integration`,
    display_version: '1.0.0',
    publisher: 'synapses',
    email: 'do-not-reply@noemail.com',
    website: 'https://github.com/williamtdr/roon-cambridge-audio'
});

let mysettings = roon.load_config("settings") || {
    serialport: "",
    startuptime: 4
};

const azur = {};
let dynamicLcd = false;

function log(msg) {
    console.log(`[Extension] ${msg}`);
}

function makelayout(settings) {
    const l = {
        values: settings,
        layout: [],
        has_error: false
    };

    l.layout.push({
        type: "string",
        title: "Serial Port",
        maxlength: 256,
        setting: "serialport"
    });

    // let inputs = [...Array(8).keys()].map(x => ({ value: (x + 1).toString(), title: `INPUT ${x + 1}` }));

    // l.layout.push({
    //     type: "dropdown",
    //     title: "Source to switch to on startup",
    //     values: inputs,
    //     setting: "setsource"
    // });

    // l.layout.push({
    //     type: "integer",
    //     title: "Initial Volume",
    //     min: 0,
    //     max: 100,
    //     setting: "initialvolume"
    // });

    l.layout.push({
        type: "integer",
        title: "Startup Time (s)",
        min: 0,
        max: 100,
        setting: "startuptime"
    });

    return l;
}

const svc_settings = new RoonApiSettings(roon, {
    get_settings: (cb) => {
        cb(makelayout(mysettings));
    },
    save_settings: (req, isdryrun, settings) => {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if(!isdryrun && !l.has_error) {
            const oldmode = mysettings.mode;
            const oldip = mysettings.ip;
            const oldport = mysettings.serialport;
            mysettings = l.values;
            svc_settings.update_settings(l);
            let force = false;
            if(oldmode !== mysettings.mode) force = true;
            if(oldport !== mysettings.serialport) force = true;
            if(force) setup();
            roon.save_config("settings", mysettings);
        }
    }
});

const svc_status = new RoonApiStatus(roon);
const svc_volume_control = new RoonApiVolumeControl(roon);
const svc_source_control = new RoonApiSourceControl(roon);

roon.init_services({
    provided_services: [svc_volume_control, svc_source_control, svc_settings, svc_status]
});

function setup() {
    if(azur.control)
        azur.control.stop();

    azur.control = new AzurProtocol();

    azur.control.on('connected', onConnected);
    azur.control.on('disconnected', onDisconnected);
    azur.control.on('volume', onVolumeChanged);
    azur.control.on('source', onSourceChanged);

    if(azur.source_control) {
        for(let source of azur.source_control)
            source.destroy();

        delete (azur.source_control);
    }
    if(azur.volume_control) {
        azur.volume_control.destroy();
        delete (azur.volume_control);
    }

    const opts = { startuptime: mysettings.startuptime };

    if(!mysettings.serialport) {
        svc_status.set_status("not configured, please check settings.", true);
        return;
    }

    opts.port = mysettings.serialport;

    log(`starting with options: ${opts}`);
    azur.control.start(opts);
}

function onConnected(status) {
    let control = azur.control;

    log("connected!");

    svc_status.set_status(`connected to ${constants.deviceName}`, false);

    azur.volume_control = svc_volume_control.new_device({
        state: {
            display_name: constants.deviceName,
            volume_type: "number",
            volume_min: constants.useRelativeVolume ? -constants.maxVolume : 0,
            volume_max: constants.useRelativeVolume ? 0 : constants.maxVolume,
            volume_value: control.properties.volume !== false ? control.properties.volume : constants.defaultVolume,
            volume_step: 1.0,
            is_muted: control.properties.source === "muted"
        },
        set_volume: (req, mode, value) => {
            let newVol = mode === "absolute" ? value : (control.properties.volume + value);

            control.setVolume(newVol);
            req.send_complete("Success");
        },
        set_mute: (req, mode) => {
            if(mode === "on")
                control.mute();
            else if(mode === "off")
                control.unmute();

            req.send_complete("Success");
        }
    });

    azur.source_control = [
        svc_source_control.new_device({
            state: {
                display_name: constants.friendlyNameSpeakerA,
                supports_standby: true,
                status: this.properties.speakers === "a" ? "selected" : "standby",
                control_key: "a"
            },
            convenience_switch: (req) => {
                if(control.properties.source === "standby") {
                    control.powerOn();
                    setTimeout(() => {
                        // restore brightness value if it changed while amp was off
                        if(dynamicLcd && dynamicLcd.hasValue) {
                            const brightnessShouldBe = dynamicLcd.brightnessShouldBe;

                            log(`restoring dynamic LCD brightness: ${brightnessShouldBe}`);

                            control.setLCDBrightness(brightnessShouldBe);
                        }

                        req.send_complete("Success");
                    }, mysettings.startuptime * 1000);
                } else {
                    req.send_complete("Success");
                }
            },
            standby: (req) => {
                control.powerOff();
                req.send_complete("Success");
            }
        }),
        svc_source_control.new_device({
            state: {
                display_name: constants.friendlyNameSpeakerB,
                supports_standby: true,
                status: this.properties.speakers === "b" ? "selected" : "standby",
                control_key: "b"
            },
            convenience_switch: (req) => {
                if(control.properties.source === "standby") {
                    control.powerOn();
                    setTimeout(() => {
                        // restore brightness value if it changed while amp was off
                        if(dynamicLcd && dynamicLcd.hasValue) {
                            const brightnessShouldBe = dynamicLcd.brightnessShouldBe;

                            log(`restoring dynamic LCD brightness: ${brightnessShouldBe}`);

                            control.setLCDBrightness(brightnessShouldBe);
                        }

                        req.send_complete("Success");
                    }, mysettings.startuptime * 1000);
                } else {
                    req.send_complete("Success");
                }
            },
            standby: (req) => {
                control.powerOff();
                req.send_complete("Success");
            }
        }),
        svc_source_control.new_device({
            state: {
                display_name: constants.friendlyNameSpeakerAB,
                supports_standby: true,
                status: this.properties.speakers === "ab" ? "selected" : "standby",
                control_key: "ab"
            },
            convenience_switch: (req) => {
                if(control.properties.source === "standby") {
                    control.powerOn();
                    setTimeout(() => {
                        // restore brightness value if it changed while amp was off
                        if(dynamicLcd && dynamicLcd.hasValue) {
                            const brightnessShouldBe = dynamicLcd.brightnessShouldBe;

                            log(`restoring dynamic LCD brightness: ${brightnessShouldBe}`);

                            control.setLCDBrightness(brightnessShouldBe);
                        }

                        req.send_complete("Success");
                    }, mysettings.startuptime * 1000);
                } else {
                    req.send_complete("Success");
                }
            },
            standby: (req) => {
                control.powerOff();
                req.send_complete("Success");
            }
        })
    ];
}

function onDisconnected(status) {
    log("disconnected");

    svc_status.set_status(`Could not connect to ${constants.deviceName} on "${mysettings.serialport}"`, true);

    if(azur.source_control) {
        azur.source_control.destroy();
        delete (azur.source_control);
    }
    if(azur.volume_control) {
        azur.volume_control.destroy();
        delete (azur.volume_control);
    }
}

function onVolumeChanged(val) {
    log(`received volume change from device: ${val}`);

    if(azur.volume_control)
        azur.volume_control.update_state({ volume_value: val });
}

function onSourceChanged(val) {
    log(`received source change from device: ${val}`);

    if(val === "muted" && azur.volume_control)
        azur.volume_control.update_state({ is_muted: true });
    else if(val === "unmuted" && azur.volume_control)
        azur.volume_control.update_state({ is_muted: false });
    else if(val === "standby" && azur.source_control) {
        for(let source of azur.source_control) {
            source.update_state({ status: "standby" });
        }
    } else {
        if(azur.volume_control)
            azur.volume_control.update_state({ is_muted: false });

        for(let source of azur.source_control) {
            source.update_state({ status: "selected" });
        }
    }
}

setup();
roon.start_discovery();

setTimeout(() => {
    azur.control.init({ port: "COM1" }, () => {});
}, 3000);

if(constants.enableHueIntegration) {
    dynamicLcd = new DynamicLcd();

    dynamicLcd.init().then(() => {
       // do nothing
    });

    dynamicLcd.on('brightnessShouldBe', newBrightness => {
        if(azur.control && azur.control.connected && azur.control.properties.source !== "standby") {
            azur.control.setLCDBrightness(newBrightness);

            log(`setting LCD brightness ot ${newBrightness} based on Hue state change...`);
        } else {
            log(`ignoring new LCD brightness value (${newBrightness}) since amplifier is not connected.`);
        }
    });
}
