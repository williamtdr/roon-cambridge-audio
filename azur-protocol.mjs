"use strict";

import SerialPort from 'serialport';
import events from 'events';
import constants from './constants.mjs';

export default class AzurProtocol extends events.EventEmitter {
    constructor() {
        super();

        this.seq = 0;
        this.connected = false;
        this.startupEpoch = 0;
    }

    log(msg) {
        console.log(`[AzurProtocol] ${msg}`);
    }

    init(opts, closecb) {
        this._qw = [];
        this._woutstanding = false;
        this.properties = {
            startuptime: opts.startuptime || 4,
            volume: false,
            speakers: constants.SPEAKER_A,
            source: "standby"
        };
        this.initializing = true;

        this._port = new SerialPort(opts.port, {
            baudRate: opts.baud || 9600,
            parser: new SerialPort.parsers.Readline("\r")
        });

        let partialCommand = "";

        this._port.on('data', data => {
            data = data.toString();

            partialCommand += data;

            if(!data.includes("\r")) {
                // we don't have a complete command yet, only a chunk of one
                return;
            } else {
                data = partialCommand;
                partialCommand = "";
            }

            if(this.initializing) {
                this.initializing = false;
                this.connected = true;
                this.emit('connected');
            }
            data = data.trim();
            this.log(`received: ${data}`);

            let commandGroup = -1;
            let commandBody = [];
            if(data.length >= 3) {
                commandGroup = parseInt(data[1]);
                commandBody = data.substr(3, data.length - 1).split(",");
            }

            switch(commandGroup) {
                case 4:
                    // replies from control commands
                    if(commandBody.length === 0)
                        throw new Error("expected a subcommand!");

                    const subcommand = parseInt(commandBody[0]);
                    switch(subcommand) {
                        case 1:
                        case 2:
                        case 3:
                        case 4:
                        case 5:
                        case 6:
                        case 7:
                            // input N selected

                            this.setSource(subcommand.toString());
                        break;
                        case 11:
                            // power state changed: 0 = standby, 1 = on
                            const powerState = parseInt(commandBody[1]);

                            if(powerState === 1) {
                                this.log(`done, ready! (${Date.now() - this.startupEpoch}ms)`);
                            }

                            this.setSource(powerState === 0 ? "standby" : constants.defaultSource);
                        break;
                        case 12:
                            // mute state changed
                            const muteState = parseInt(commandBody[1]);

                            this.setSource(muteState === 1 ? "muted" : constants.defaultSource);
                        break;
                        case 13:
                            // volume level, 0-96
                            const volume = parseInt(commandBody[1]);

                            if(this.properties.volume !== volume) {
                                this.log(`Changing volume from ${this.properties.volume} to ${volume}`);

                                if(constants.useRelativeVolume) {
                                    this.properties.volume = -(constants.maxVolume - volume);
                                    this.emit('volume', -(constants.maxVolume - volume));
                                } else {
                                    this.properties.volume = volume;
                                    this.emit('volume', volume);
                                }
                            }
                        break;
                        case 20:
                            // this is the first command the amp sends when it turns on,
                            // for some reason
                            const lcdBrightness = parseInt(commandBody[1]);

                            this.startupEpoch = Date.now();

                            this.log("starting up...");
                        break;
                        case 21:
                            const speakers = parseInt(commandBody[1]);

                            this.properties.speakers = speakers;

                            this.emit('speakers', this.properties.speakers);
                        break;
                        default:
                            this.log(`unhandled reply from control command: ${subcommand}`);
                    }
                break;
                case 5:
                    // errors
                    this.log("amplifier error :(");
                break;
                default:
                    this.log("didn't expect to see a reply here...");
            }
        });

        setTimeout(() => {
            if(this.initializing) {
                this.initializing = false;
                this.connected = true;
                this.emit('connected');
            }
        }, this.properties.startuptime * 1000);

        this._port.on('open', err => {
            this.emit('preconnected');
            this.properties.source = "standby";
        });

        this._port.on('close', () => {
            this._port.close(() => {
                this._port = undefined;

                if(closecb) {
                    const deref = closecb;
                    closecb = undefined;
                    deref('close');
                }
            })
        });

        this._port.on('error', err => {
            this._port.close(() => {
                this._port = undefined;

                if(closecb) {
                    const deref = closecb;
                    closecb = undefined;
                    deref('error');
                }
            })
        });

        this._port.on('disconnect', () => {
            this._port.close(() => {
                this._port = undefined;
                if(closecb) {
                    const deref = closecb;
                    closecb = undefined;
                    deref('disconnect');
                }
            })
        });
    }

    setSpeaker(val) {
        this.send(`#1,21,${val}\r`);
    }

    setLCDBrightness(val) {
        // 0 - Off, 1 - Dim, 2 - Bright
        // this.send(`#1,20,${val}`);
        throw("this doesn't have any effect (tested on 840av2)");
    }

    setSource(val) {
        this.log(`source: ${val}`);

        if(this.properties.source !== val) {
            this.properties.source = val;
            this.emit('source', val);
        }
    }

    send(val, cb) {
        this._qw.push(val);
        this._processw();

        if(cb)
            cb();
    };

    volumeUp() {
        this.send("#1,14,\r");
    }

    volumeDown() {
        this.send("#1,15,\r");
    }

    setVolume(val) {
        if(this.properties.volume === val) return;

        if(val > constants.maxSafeVolume)
            val = constants.maxSafeVolume;

        if(val < 0)
            val = 0;

        if(constants.useRelativeVolume)
            val += 96;

        if(this.volumetimer) clearTimeout(this.volumetimer);
        this.volumetimer = setTimeout(() => {
            this.send(`#1,13,${val}\r`);
        }, 50);
    };

    powerOff() {
        this.send("#1,11,0\r");
        this.setSource("standby");
    }

    powerOn() {
        this.send("#1,11,1\r");
    }

    mute() {
        this.send("#1,12,1\r");
    }

    unmute() {
        this.send("#1,12,0\r");
    }

    _processw() {
        if(!this._port) return;
        if(this._woutstanding) return;
        if(this._qw.length === 0) return;

        this._woutstanding = true;
        this.log(`writing: ${this._qw[0]}`);

        this._port.write(this._qw[0] + "\n",
            (err) => {
                if(err) return;
                this._qw.shift();
                this._woutstanding = false;
                setTimeout(() => {
                    this._processw();
                }, 150);
            });
    }

    start(opts) {
        this.seq++;

        let closecb = (why) => {
            this.emit('disconnected');
            this.connected = false;

            if(why !== 'close') {
                let seq = ++this.seq;
                setTimeout(() => {
                    if(seq !== this.seq) return;
                    this.start(opts);
                }, 1000);
            }
        };

        if(this._port) {
            this._port.close(() => {
                this.init(opts, closecb);
            });
        } else {
            this.init(opts, closecb);
        }
    };

    stop() {
        this.seq++;

        if(this._port)
            this._port.close(() => {});
    };
}
