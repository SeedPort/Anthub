import {forwardRef, Inject, Injectable, Logger} from '@nestjs/common';
import {MessageBuilder, SocketService} from "../harbor/socket.service";
import {NoPierAvailableError} from "../errors/NoPierAvailableError";
import {IRobot} from "../models/robot/types";
import {Robot} from "../db/robot";
import {InjectConnection, InjectModel} from "@nestjs/sequelize";
import {Sequelize, Transaction} from "sequelize";
import {RoboHarborError} from "../errors/RoboHarborError";
import {uniqueNamesGenerator, adjectives, colors, animals, Config} from 'unique-names-generator';
import {Log} from "../db/log.model";
import {Credentials} from "../db/credentials.model";
import {Images} from "../db/images.model";
import {PiersService} from "../piers/piers.service";
const config: Config = {
    dictionaries: [adjectives, colors, animals],
    separator: '-',
};


@Injectable()
export class RobotsService {

    private readonly logger = new Logger(RobotsService.name);
    private logQueue: any = [];
    private saveLogTimer: any = null;
    private lastTimeSaved: Date;

    constructor(
                @Inject(forwardRef(() => SocketService))
                readonly socketService: SocketService,
                @Inject(forwardRef(() => PiersService))
                private pierService: PiersService,
                @InjectModel(Credentials)
                private credentialsModel: typeof Credentials,
                @InjectModel(Images)
                private imageModel: typeof Images,
                @InjectConnection()
                private sequelize: Sequelize,) {
    }

    attachFullInformationToRobot(bot: IRobot) {
        return new Promise(async (resolve, reject) => {
            if (!bot.id) {
                bot.id = Math.floor(Math.random() * 1000000);
            }
            if (!bot.identifier) {
                if (process.env.DEV_KUBERNETES !== "development") {
                    bot.identifier = uniqueNamesGenerator(config);
                }
                else {
                    bot.identifier = "your-test-robot-identifier";
                }
            }
            if (bot.source?.credentials) {
                bot.source.credentials = await this.credentialsModel.findOne({
                    where: {
                        id: bot.source.credentials.id
                    }
                });
            }
            return resolve(bot);
        });
    }

    async validateRobot(bot: any) {
        bot = await this.attachFullInformationToRobot(bot);
        return this.pierService.validateRobot(bot)
            .then((res) => {
                if (res.isError) {
                    throw new RoboHarborError(res.error_code, res.error, res);
                    return;
                }
                return {
                    ...res
                }
            })
    }
    
    saveLogsLater() {
        return new Promise<void>((resolve, reject) => {
           try {
               
                if (this.logQueue.length > 0) {
                    const saveLogs = () => {
                        const logs = this.logQueue;
                        this.sequelize.transaction(async (t: Transaction) => {
                            await Log.bulkCreate(logs, {transaction: t});
                            return Promise.resolve();
                        })
                        .then(() => {
                            this.logQueue = [];
                            this.lastTimeSaved = new Date();
                            return resolve();
                        })
                        .catch((err) => {
                            this.logQueue = this.logQueue.concat(logs);
                            return reject(err);
                        });
                    }
                    
                    this.saveLogTimer = setTimeout(saveLogs, 1000);
                    if (this.lastTimeSaved) {
                        const diff = new Date().getTime() - this.lastTimeSaved.getTime();
                        if (diff > 3400) {
                            clearTimeout(this.saveLogTimer);
                            saveLogs();
                        }
                    }
                }
               
               return resolve();
           } 
           catch(e) {
               reject(e);
           }
        });
    }

    logRobot(robotId: number, level: string, logs: string) {
        return new Promise<void>((resolve, reject) => {
            try {
                this.logQueue.push({
                    robotId: robotId,
                    level: level,
                    logs: logs,
                    date: new Date()
                });
                this.saveLogsLater();
                return resolve();
            }
            catch (e) {
                reject(e);
            }
        });

    }

    async createRobot(bot: IRobot) {
        const pierId = this.socketService.getBestPier();
        if (pierId) {
            // Start a transaction to create a robot and add it to a pier
            this.sequelize.transaction(async (t: Transaction) => {


                this.logger.log("Robot created, pierId: " + pierId);
                const robot = new Robot();

                robot.name = bot.name;
                robot.source = bot.source;
                robot.image = bot.image;
                robot.config = bot.config;
                robot.type = bot.type;

                robot.identifier = uniqueNamesGenerator(config);


                const createdRobot = await robot.save({transaction: t});

                return Promise.resolve(createdRobot);
            })
                .then((res) => {
                    this.socketService.sendMessageWithoutResponse(pierId, MessageBuilder.reloadRobots())
                        .catch((e) => {
                            this.logger.error("Error reloading robots: ", e);
                        });
                  return res;
                })
                .then((res) => {
                return Promise.resolve(res.dataValues);
                }
            )
            .catch((err) => {
               throw new RoboHarborError(991, "Creation Error", {error: err.message});
            });


        }
        else {
            this.logger.error("Can not create robot, no pier available");
            throw new NoPierAvailableError( {
                bot: bot
            });
        }
    }

    async getAllRobots() {
        return Robot.findAll({
            nest: true,
        });
    }

    async getRobot(id: string) {
        return Robot.findOne({
            where: {
                id: id
            }
        })
        .then((res) => {
            if (res) {
                return res;
            }
            throw new RoboHarborError(404, "Robot not found");
        });
    }

    async getRobotPopulated(id: string) {
        return Robot.findOne({
            where: {
                id: id
            }
        })
        .then((res) => {
            if (res) {
                return this.expandRobotDetails(res);
            }
            throw new RoboHarborError(404, "Robot not found");
        });
    }

    async reloadSource(id: string) {
        const robot = await this.getRobot(id.toString());
        if (!robot) {
            throw new RoboHarborError(404, "Robot not found");
        }
        return this.socketService.sendMessageToRobotWithResponse(robot.identifier, MessageBuilder.reloadSourceMessage(robot))
            .then((res: any) => {
                robot.sourceInfo = res.sourceInfo;
                return robot.save();
            });
    }

    async runRobot(id: string) {
        const robot = await this.getRobot(id);
        if (!robot) {
            throw new RoboHarborError(404, "Robot not found");
        }
        robot.enabled = true;
        await robot.save();
        return this.socketService.sendMessageToRobotWithResponse(robot.identifier, MessageBuilder.runRobotMessage(robot))
            .then((res) => {
                return res;
            });
    }

    async stopRobot(id: string) {
        const robot = await this.getRobot(id);
        if (!robot) {
            throw new RoboHarborError(404, "Robot not found");
        }
        robot.enabled = false;
        await robot.save();
        return this.socketService.sendMessageToRobotWithResponse(robot.identifier, MessageBuilder.stopRobotMessage(robot))
            .then((res) => {
                return res;
            });
    }

    async updateRobot(id: string, bot: IRobot) {
        const robot = await this.getRobot(id);
        if (!robot) {
            throw new RoboHarborError(404, "Robot not found");
        }
        if (bot.name) {
            robot.name = bot.name;
        }
        if (bot.source) {
            robot.source = bot.source;
        }
        if (bot.windowJson) {
            robot.windowJson = bot.windowJson;
        }
        if (bot.image) {
            robot.image = bot.image;
        }
        if (bot.config) {
            robot.config = bot.config;
        }
        if (bot.type) {
            robot.type = bot.type;
        }
        await robot.save();
        this.socketService.sendMessageWithoutResponse(robot.identifier, MessageBuilder.reloadRobots())
            .catch((e) => {
                this.logger.error("Error reloading robots: ", e);
            });

        return robot;
    }

    async deleteRobot(id: string) {
        const robot = await this.getRobot(id);
        if (!robot) {
            throw new RoboHarborError(404, "Robot not found");
        }
        await robot.destroy();
        return robot;
    }

    async getAllCredentials(columns: string[] = []) {
        const options = {
            nest: true,

        };
        if (columns.length > 0) {
            options['attributes'] = columns;
        }
        return this.credentialsModel.findAll(options);
    }

    async createCredentials(credentials: any) {
        return this.credentialsModel.create(credentials);
    }

    async updateSource(id: string) {
        const robot = await this.getRobot(id);
        if (!robot) {
            throw new RoboHarborError(404, "Robot not found");
        }
        return this.socketService.sendMessageToRobotWithResponse(robot.identifier, MessageBuilder.updateSourceMessage(robot))
            .then((res) => {
                return res;
            });
    }

    async deleteRobotById(id: string) {
        const robot = await this.getRobot(id);
        if (!robot) {
            throw new RoboHarborError(404, "Robot not found");
        }
        return this.socketService.sendMessageToRobotWithResponse(robot.identifier, MessageBuilder.deleteRobotMessage(robot))
            .then((res) => {
                Robot.destroy({
                    where: {
                        id: id
                    }
                });
                return res;
            });
    }

    expandRobotDetails(r: IRobot) {
        return new Promise(async (resolve, reject) => {
           try {
               if (r.source) {
                   if (r.source.credentials) {
                       try {
                           const credentials = (await this.credentialsModel.findOne({
                               where: {
                                   id: r.source.credentials.id
                               },
                               nest: true
                           }));
                           r.source.credentials = credentials ? credentials.dataValues : null;
                       }
                       catch(e) {}

                   }
               }
               return resolve(r);
           }
          catch(e) {
              this.logger.error("Error expanding robot details: ", e);
              return resolve(r);
          }
        });
    }
}
