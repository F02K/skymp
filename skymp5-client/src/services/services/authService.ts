import * as fs from "fs";
import { AuthGameData, RemoteAuthGameData, authGameDataStorageKey } from "../../features/authModel";
import { FunctionInfo } from "../../lib/functionInfo";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent, Menu, browser } from "skyrimPlatform";
import { AuthNeededEvent } from "../events/authNeededEvent";
import { BrowserWindowLoadedEvent } from "../events/browserWindowLoadedEvent";
import { logTrace, logError } from "../../logging";
import { ConnectionMessage } from "../events/connectionMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { NetworkingService } from "./networkingService";
import { MsgType } from "../../messages";
import { ConnectionDenied } from "../events/connectionDenied";

// for browsersideWidgetSetter
declare const window: any;

// Constants used on both client and browser side (see browsersideWidgetSetter)
const events = {
  openDiscordOauth: 'openDiscordOauth',
  authAttempt: 'authAttemptEvent',
  openGithub: 'openGithub',
  openPatreon: 'openPatreon',
  clearAuthData: 'clearAuthData',
  updateRequired: 'updateRequired',
  backToLogin: 'backToLogin',
  joinDiscord: 'joinDiscord'
};

// Vaiables used on both client and browser side (see browsersideWidgetSetter)
let browserState = {
  comment: '',
  failCount: 9000,
  loginFailedReason: '',
};
let authData: RemoteAuthGameData | null = null;

const translations = {
  "ru": {
    loginViaDiscord: 'войдите через discord',
    joinDiscordServer: 'вступите в discord сервер',
    banned: 'вы забанены',
    whatWasThat: 'что это было?',
    openingBrowser: 'открываем браузер...',
    loginFirst: 'сначала войдите',
    linkedSuccessfully: 'привязан успешно',
    connecting: 'подключение',
    technicalIssues: 'технические шоколадки\nпопробуйте еще раз\nпожалуйста\nили напишите нам в discord',
    authorization: 'Авторизация',
    notAuthorized: 'не авторизирован',
    changeAccount: 'сменить аккаунт',
    loginViaSkymp: 'войти через skymp',
    play: 'Играть',
    loginOrChangeHint: 'Вы можете войти или поменять аккаунт',
    connectToServer: 'Подключиться к игровому серверу',
    updateCaption: 'новинка',
    updateAvailable: 'ура! вышло обновление',
    downloadAt: 'спешите скачать на',
    openSkympNet: 'открыть skymp.net',
    updateDownloadHint: 'Перейти на страницу скачивания обновления',
    oops: 'упс',
    join: 'вступить',
    back: 'назад',
  },
  "en": {
    loginViaDiscord: 'log in via Discord',
    joinDiscordServer: 'join the Discord server',
    banned: 'you are banned',
    whatWasThat: 'what was that?',
    openingBrowser: 'opening browser...',
    loginFirst: 'log in first',
    linkedSuccessfully: 'linked successfully',
    connecting: 'connecting',
    technicalIssues: 'technical difficulties\nplease try again\nor contact us on Discord',
    authorization: 'Authorization',
    notAuthorized: 'not authorized',
    changeAccount: 'change account',
    loginViaSkymp: 'log in via skymp',
    play: 'Play',
    loginOrChangeHint: 'You can log in or change your account',
    connectToServer: 'Connect to game server',
    updateCaption: 'Update',
    updateAvailable: 'a new update is available!',
    downloadAt: 'download it at',
    openSkympNet: 'open skymp.net',
    updateDownloadHint: 'Go to the update download page',
    oops: 'oops',
    join: 'join',
    back: 'back',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['ru']]: string };

let strings: TranslationStrings = translations['en'];

try {
  const lang = fs.readFileSync('./Data/Platform/Distribution/locale', 'utf8').trim();
  if (lang in translations) {
    strings = translations[lang as keyof typeof translations];
    const src = `window.setLanguage(${lang})`;
    browser.executeJavaScript(src);
  }
} catch {
  // locale file not found or unreadable, default to 'en'
}

export class AuthService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("authNeeded", (e) => this.onAuthNeeded(e));
    this.controller.emitter.on("browserWindowLoaded", (e) => this.onBrowserWindowLoaded(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
    this.controller.emitter.on("connectionAccepted", () => this.handleConnectionAccepted());
    this.controller.emitter.on("connectionDenied", (e) => this.handleConnectionDenied(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("tick", () => this.onTick());
    this.controller.once("update", () => this.onceUpdate());

    if (this.sp.settings["skymp5-client"]["launchMode"] !== "directory-managed") {
      browserState.loginFailedReason = "Dieser Client muss über einen aktuellen SkyMP Launcher gestartet werden.";
      browserState.comment = "This client must be started through a current SkyMP Launcher.";
      this.setListenBrowserMessage(true, "launcher-managed runtime data is missing");
      this.trigger.authNeededFired = true;
    }
  }

  private onAuthNeeded(e: AuthNeededEvent) {
    logTrace(this, `Received authNeeded event`);

    const managed = this.sp.settings["skymp5-client"]["launchMode"] === "directory-managed";
    authData = this.readAuthDataFromDisk();
    if (managed && authData?.session) {
      logTrace(this, "Using launcher-provided Directory session");
      this.controller.emitter.emit("authAttempt", { authGameData: { remote: authData } });
      this.authAttemptProgressIndicator = true;
      return;
    }

    browserState.loginFailedReason = "Dieser Client muss über einen aktuellen SkyMP Launcher gestartet werden.";
    browserState.comment = "This client must be started through a current SkyMP Launcher.";
    this.setListenBrowserMessage(true, "launcher-managed runtime data is missing");
    this.trigger.authNeededFired = true;
    if (this.trigger.conditionMet) {
      this.onBrowserWindowLoadedAndOnlineAuthNeeded();
    }
  }

  private onBrowserWindowLoaded(e: BrowserWindowLoadedEvent) {
    logTrace(this, `Received browserWindowLoaded event`);

    this.trigger.browserWindowLoadedFired = true;
    if (this.trigger.conditionMet) {
      this.onBrowserWindowLoadedAndOnlineAuthNeeded();
    }
  }

  private onCreateActorMessage(e: ConnectionMessage<CreateActorMessage>) {
    if (e.message.isMe) {
      if (this.authDialogOpen) {
        logTrace(this, `Received createActorMessage for self, resetting widgets`);
        this.sp.browser.executeJavaScript('window.skyrimPlatform.widgets.set([]);');
        this.authDialogOpen = false;
      } else {
        logTrace(this, `Received createActorMessage for self, but auth dialog was not open so not resetting widgets`);
      }
    }

    this.loggingStartMoment = 0;
    this.authAttemptProgressIndicator = false;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const msg = event.message;

    let msgContent: Record<string, unknown> = {};

    try {
      msgContent = JSON.parse(msg.contentJsonDump);
    } catch (e) {
      if (e instanceof SyntaxError) {
        logError(this, "onCustomPacketMessage failed to parse JSON", e.message, "json:", msg.contentJsonDump);
        return;
      } else {
        throw e;
      }
    }

    switch (msgContent["customPacketType"]) {
      case 'loginFailedNotLoggedViaDiscord':
        this.authAttemptProgressIndicator = false;
        this.controller.lookupListener(NetworkingService).close();
        logTrace(this, 'loginFailedNotLoggedViaDiscord received');
        browserState.loginFailedReason = strings.loginViaDiscord;
        browserState.comment = '';
        this.setListenBrowserMessage(true, 'loginFailedNotLoggedViaDiscord received');
        this.loggingStartMoment = 0;
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
      case 'loginFailedNotInTheDiscordServer':
        this.authAttemptProgressIndicator = false;
        this.controller.lookupListener(NetworkingService).close();
        logTrace(this, 'loginFailedNotInTheDiscordServer received');
        browserState.loginFailedReason = strings.joinDiscordServer;
        browserState.comment = '';
        this.setListenBrowserMessage(true, 'loginFailedNotInTheDiscordServer received');
        this.loggingStartMoment = 0;
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
      case 'loginFailedBanned':
        this.authAttemptProgressIndicator = false;
        this.controller.lookupListener(NetworkingService).close();
        logTrace(this, 'loginFailedBanned received');
        browserState.loginFailedReason = strings.banned;
        browserState.comment = '';
        this.setListenBrowserMessage(true, 'loginFailedBanned received');
        this.loggingStartMoment = 0;
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
      case 'loginFailedIpMismatch':
        this.authAttemptProgressIndicator = false;
        this.controller.lookupListener(NetworkingService).close();
        logTrace(this, 'loginFailedIpMismatch received');
        browserState.loginFailedReason = strings.whatWasThat;
        browserState.comment = '';
        this.setListenBrowserMessage(true, 'loginFailedIpMismatch received');
        this.loggingStartMoment = 0;
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
    }
  }

  private onBrowserWindowLoadedAndOnlineAuthNeeded() {
    if (!this.isListenBrowserMessage()) {
      logError(this, `isListenBrowserMessage was false for some reason, aborting auth`);
      return;
    }

    logTrace(this, "Showing launcher-required message");
    this.refreshWidgets();
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  private onBrowserMessage(e: BrowserMessageEvent) {
    if (!this.isListenBrowserMessage) {
      logTrace(this, `onBrowserMessage: isListenBrowserMessage was false, ignoring message`, JSON.stringify(e.arguments));
      return;
    }

    logTrace(this, `onBrowserMessage:`, JSON.stringify(e.arguments));

    const eventKey = e.arguments[0];
    switch (eventKey) {
      case events.openDiscordOauth:
        browserState.loginFailedReason = "Dieser Client muss über einen aktuellen SkyMP Launcher gestartet werden.";
        browserState.comment = "Discord login is handled by the launcher.";
        this.refreshWidgets();
        break;
      case events.authAttempt:
        if (authData === null) {
          browserState.comment = strings.loginFirst;
          this.refreshWidgets();
          break;
        }

        this.writeAuthDataToDisk(authData);
        this.controller.emitter.emit("authAttempt", { authGameData: { remote: authData } });

        this.authAttemptProgressIndicator = true;

        break;
      case events.clearAuthData:
        // Doesn't seem to be used
        this.writeAuthDataToDisk(null);
        break;
      case events.openGithub:
        this.sp.win32.loadUrl(this.githubUrl);
        break;
      case events.openPatreon:
        this.sp.win32.loadUrl(this.patreonUrl);
        break;
      case events.updateRequired:
        this.sp.win32.loadUrl("https://skymp.net/UpdInstall");
        break;
      case events.backToLogin:
        this.sp.browser.executeJavaScript(new FunctionInfo(this.browsersideWidgetSetter).getText({ events, browserState, authData: authData, strings }));
        break;
      case events.joinDiscord:
        this.sp.win32.loadUrl("https://discord.gg/9KhSZ6zjGT");
        break;
      default:
        break;
    }
  }

  private refreshWidgets() {
    this.sp.browser.executeJavaScript(new FunctionInfo(this.browsersideWidgetSetter).getText({ events, browserState, authData: authData, strings }));
    this.authDialogOpen = true;
  };

  public readAuthDataFromDisk(): RemoteAuthGameData | null {
    logTrace(this, `Reading`, this.pluginAuthDataName, `from disk`);

    try {
      // @ts-expect-error (TODO: Remove in 2.10.0)
      const data = this.sp.getPluginSourceCode(this.pluginAuthDataName, "PluginsNoLoad");

      if (!data) {
        logTrace(this, `Read empty`, this.pluginAuthDataName, `returning null`);
        return null;
      }

      const parsed = JSON.parse(data.slice(2)) as Partial<RemoteAuthGameData> | null;
      if (
        !parsed ||
        typeof parsed.session !== "string" ||
        !parsed.session ||
        (parsed.profileId !== undefined && !Number.isInteger(parsed.profileId))
      ) {
        logError(this, "Launcher auth data is malformed");
        return null;
      }
      return parsed as RemoteAuthGameData;
    } catch (e) {
      logError(this, `Error reading`, this.pluginAuthDataName, `from disk:`, e, `, falling back to null`);
      return null;
    }
  }

  private writeAuthDataToDisk(data: RemoteAuthGameData | null) {
    const content = "//" + (data ? JSON.stringify(data) : "null");

    logTrace(this, `Writing`, this.pluginAuthDataName, `to disk:`, content);

    try {
      this.sp.writePlugin(
        this.pluginAuthDataName,
        content,
        // @ts-expect-error (TODO: Remove in 2.10.0)
        "PluginsNoLoad"
      );
    } catch (e) {
      logError(this, `Error writing`, this.pluginAuthDataName, `to disk:`, e, `, will not remember user`);
    }
  };

  private deniedWidgetSetter = () => {
    const widget = {
      type: "form",
      id: 2,
      caption: strings.updateCaption,
      elements: [
        {
          type: "text",
          text: strings.updateAvailable,
          tags: []
        },
        {
          type: "text",
          text: strings.downloadAt,
          tags: []
        },
        {
          type: "text",
          text: "skymp.net",
          tags: []
        },
        {
          type: "button",
          text: strings.openSkympNet,
          tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
          click: () => window.skyrimPlatform.sendMessage(events.updateRequired),
          hint: strings.updateDownloadHint,
        }
      ]
    }
    window.skyrimPlatform.widgets.set([widget]);

    // Make sure gamemode will not be able to update widgets anymore
    window.skyrimPlatform.widgets = null;
  }

  private loginFailedWidgetSetter = () => {
    const splitParts = browserState.loginFailedReason.split('\n');

    const textElements = splitParts.map((part) => ({
      type: "text",
      text: part,
      tags: [],
    }));

    const widget = {
      type: "form",
      id: 2,
      caption: strings.oops,
      elements: new Array<any>()
    }

    textElements.forEach((element) => widget.elements.push(element));

    if (browserState.loginFailedReason === strings.joinDiscordServer) {
      widget.elements.push({
        type: "button",
        text: strings.join,
        tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
        click: () => window.skyrimPlatform.sendMessage(events.joinDiscord),
        hint: null
      });
    }

    widget.elements.push({
      type: "button",
      text: strings.back,
      tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
      click: () => window.skyrimPlatform.sendMessage(events.backToLogin),
      hint: undefined
    });

    window.skyrimPlatform.widgets.set([widget]);
  }

  private browsersideWidgetSetter = () => {
    const loginWidget = {
      type: "form",
      id: 1,
      caption: strings.authorization,
      elements: [
        // {
        //   type: "button",
        //   tags: ["BUTTON_STYLE_GITHUB"],
        //   hint: "get a colored nickname and mention in news",
        //   click: () => window.skyrimPlatform.sendMessage(events.openGithub),
        // },
        // {
        //   type: "button",
        //   tags: ["BUTTON_STYLE_PATREON", "ELEMENT_SAME_LINE", "HINT_STYLE_RIGHT"],
        //   hint: "get a colored nickname and other bonuses for patrons",
        //   click: () => window.skyrimPlatform.sendMessage(events.openPatreon),
        // },
        // {
        //   type: "icon",
        //   text: "username",
        //   tags: ["ICON_STYLE_SKYMP"],
        // },
        // {
        //   type: "icon",
        //   text: "",
        //   tags: ["ICON_STYLE_DISCORD"],
        // },
        {
          type: "text",
          text: (
            authData ? (
              authData.discordUsername
                ? `${authData.discordUsername}`
                : `id: ${authData.profileId}`
            ) : strings.notAuthorized
          ),
          tags: [/*"ELEMENT_SAME_LINE", "ELEMENT_STYLE_MARGIN_EXTENDED"*/],
        },
        // {
        //   type: "icon",
        //   text: "discord",
        //   tags: ["ICON_STYLE_DISCORD"],
        // },
        {
          type: "button",
          text: authData ? strings.changeAccount : strings.loginViaSkymp,
          tags: [/*"ELEMENT_SAME_LINE"*/],
          click: () => window.skyrimPlatform.sendMessage(events.openDiscordOauth),
          hint: strings.loginOrChangeHint,
        },
        {
          type: "button",
          text: strings.play,
          tags: ["BUTTON_STYLE_FRAME", "ELEMENT_STYLE_MARGIN_EXTENDED"],
          click: () => window.skyrimPlatform.sendMessage(events.authAttempt),
          hint: strings.connectToServer,
        },
        {
          type: "text",
          text: browserState.comment,
          tags: [],
        },
      ]
    };
    window.skyrimPlatform.widgets.set([loginWidget]);
  };

  private handleConnectionDenied(e: ConnectionDenied) {
    this.authAttemptProgressIndicator = false;

    if (e.error.toLowerCase().includes("invalid password")) {
      this.controller.once("tick", () => {
        this.controller.lookupListener(NetworkingService).close();
      });
      this.sp.browser.executeJavaScript(new FunctionInfo(this.deniedWidgetSetter).getText({ events, strings }));
      this.sp.browser.setVisible(true);
      this.sp.browser.setFocused(true);
      this.controller.once("update", () => {
        this.sp.Game.disablePlayerControls(true, true, true, true, true, true, true, true, 0);
      });
      this.setListenBrowserMessage(true, 'connectionDenied event received');
    }
  }

  private handleConnectionAccepted() {
    this.setListenBrowserMessage(false, 'connectionAccepted event received');
    this.loggingStartMoment = Date.now();

    const authData = this.sp.storage[authGameDataStorageKey] as AuthGameData | undefined;
    if (authData?.local) {
      logTrace(this,
        `Logging in offline mode, profileId =`, authData.local.profileId
      );
      const message: CustomPacketMessage = {
        t: MsgType.CustomPacket,
        contentJsonDump: JSON.stringify({
          customPacketType: 'loginWithLauncherSession',
          gameData: {
            profileId: authData.local.profileId,
          },
        }),
      };
      this.controller.emitter.emit("sendMessage", {
        message: message,
        reliability: "reliable"
      });
      return;
    }

    if (authData?.remote) {
      logTrace(this, 'Logging in with a launcher-provided backend session');
      const message: CustomPacketMessage = {
        t: MsgType.CustomPacket,
        contentJsonDump: JSON.stringify({
          customPacketType: 'loginWithLauncherSession',
          gameData: {
            session: authData.remote.session,
          },
        }),
      };
      this.controller.emitter.emit("sendMessage", {
        message: message,
        reliability: "reliable"
      });
      return;
    }

    logError(this, 'Not found authentication method');
  };

  private onTick() {
    // TODO: Should be no hardcoded/magic-number limit
    // TODO: Busy waiting is bad. Should be replaced with some kind of event
    const maxLoggingDelay = 15000;
    if (this.loggingStartMoment && Date.now() - this.loggingStartMoment > maxLoggingDelay) {
      logTrace(this, 'Max logging delay reached received');

      if (this.playerEverSawActualGameplay) {
        logTrace(this, 'Player saw actual gameplay, reconnecting');
        this.loggingStartMoment = 0;
        this.controller.lookupListener(NetworkingService).reconnect();
        // TODO: should we prompt user to relogin?
      } else {
        logTrace(this, 'Player never saw actual gameplay, showing login dialog');
        this.loggingStartMoment = 0;
        this.authAttemptProgressIndicator = false;
        this.controller.lookupListener(NetworkingService).close();
        browserState.comment = "";
        browserState.loginFailedReason = strings.technicalIssues;
        this.sp.browser.executeJavaScript(new FunctionInfo(this.loginFailedWidgetSetter).getText({ events, browserState, authData: authData, strings }));

        authData = null;
        this.writeAuthDataToDisk(null);
      }
    }

    if (this.authAttemptProgressIndicator) {
      this.authAttemptProgressIndicatorCounter++;

      if (this.authAttemptProgressIndicatorCounter === 1000000) {
        this.authAttemptProgressIndicatorCounter = 0;
      }

      const slowCounter = Math.floor(this.authAttemptProgressIndicatorCounter / 15);

      const dot = slowCounter % 3 === 0 ? '.' : slowCounter % 3 === 1 ? '..' : '...';

      browserState.comment = strings.connecting + dot;
      this.refreshWidgets();
    }
  }

  private onceUpdate() {
    this.playerEverSawActualGameplay = true;
  }

  private isListenBrowserMessage() {
    return this._isListenBrowserMessage;
  }

  private setListenBrowserMessage(value: boolean, reason: string) {
    logTrace(this, `setListenBrowserMessage:`, value, `reason:`, reason);
    this._isListenBrowserMessage = value;
  }

  private _isListenBrowserMessage = false;

  private trigger = {
    authNeededFired: false,
    browserWindowLoadedFired: false,

    get conditionMet() {
      return this.authNeededFired && this.browserWindowLoadedFired
    }
  };
  private authDialogOpen = false;

  private loggingStartMoment = 0;

  private authAttemptProgressIndicator = false;
  private authAttemptProgressIndicatorCounter = 0;

  private playerEverSawActualGameplay = false;

  private readonly githubUrl = "https://github.com/skyrim-multiplayer/skymp";
  private readonly patreonUrl = "https://www.patreon.com/skymp";
  private readonly pluginAuthDataName = `auth-data-no-load`;
}
