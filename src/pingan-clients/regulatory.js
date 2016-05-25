import net from 'net';
import iconv from 'iconv-lite';
import api from './regulatory-description';
import dateFormat from 'dateformat';
import ConnectionPool from 'jackpot';

/**
 * Encodes UTF-8 String to GBK Encoded Buffer
 * @param  {String} string UTF-8 String
 * @return {String}        GBK Encoded Buffer
 */
function gbkEncode(string) {
  return iconv.encode(string, 'gbk');
}

/**
 * Decudes GBK Encoded Buffer to UTF-8 String
 * @param  {Buffer} buffer GBK Encoded Buffer
 * @return {String}        UTF-8 String
 */
function gbkDecode(buffer) {
  return iconv.decode(buffer, 'gbk');
}

/**
 * Return a fixed width string filled with spacer
 * @param  {String} string Original String
 * @param  {Number} width  Expected width
 * @param  {String} spacer Spacing character
 * @return {String}        String with spacer and fixed width
 */
function padString(string, width, spacer) {
  spacer = spacer ? spacer.slice(0, 1) : '0';
  // Translate to String.
  string = string.toString();
  if (string.length === width) {
    return string;
  }
  if (string.length > width) {
    return string.substr(string.length - width);
  }
  return Array(width + 1 - string.length).join(spacer) + string;
}

class RegulatoryMessage {
  /**
   * Class Constructor
   * @param {String} clientConfig 客户端配置
   * @param {String} clientLogId  第三方系统流水ID
   * @param {String} functionCode (4 digit string) according to Pingan Bank.
   * @param {Object} paramsList   Keys and values.
   */
  constructor(clientConfig, clientLogId, functionCode, paramsList) {
    // Links client configuration file.
    this._clientConfig = clientConfig;

    // Validates and stores client side ID;
    // Use last 20 digits or fill up string with '0'
    this._clientLogId = padString(clientLogId, 20, '0');

    // Validates and stores function code
    this._functionCode = functionCode;
    if (!api.request.hasOwnProperty(functionCode)) {
      throw new Error('[PINGAN] Pingan Invalid Function Code');
    }

    // Saves parameter list
    this._paramsList = paramsList;
    this._messageBody = this.composeMessageBody();
    this._messageHead = this.composeMessageHead();
    this._networkHead = this.composeNetworkHead();
  }

  /**
   * Creates message body string
   * @return {String} Message Body
   */
  composeMessageBody() {
    /* eslint no-unused-vars: ["error", { "varsIgnorePattern": "^self$" }] */
    let self = this;
    let extract = (keyObject, dataObject) => {
      // Throws Error for missing required param;
      if (keyObject.required && !dataObject.hasOwnProperty(keyObject.key)) {
        throw new Error('[PINGAN] Missing key ${keyObject.key} for function ' +
                        '${self._functionCode}');
      }
      // Writes default value for non-existing params;
      if (!dataObject.hasOwnProperty(keyObject.key)) {
        return keyObject.default || '';
      }
      // Validate data
      let value = dataObject[keyObject.key];
      if (keyObject.type === String && !/^\d+$/.test(value)) {
        throw new Error('[PINGAN] Incorrect key ${keyObject.key} format for ' +
                        'function ${self._functionCode}');
      } else if (value.length > keyObject.length) {
        throw new Error('[PINGAN] Key ${keyObject.key} overflow for function ' +
                        '${self._functionCode}');
      }
      return value;
    };
    let keyDictionary = api.request[this._functionCode];
    let messageBody = '';

    for (let key of keyDictionary) {
      if (key instanceof Array) {
        for (let listItem of this._paramsList.list) {
          for (let subKey of key) {
            messageBody += extract(subKey, listItem) + '&';
          }
        }
      } else {
        messageBody += extract(key, this._paramsList) + '&';
      }
    }
    return messageBody;
  }

  /**
   * Creates message head string
   * @return {String} Message Head
   */
  composeMessageHead() {
    let messageHead = '';

    messageHead += this._functionCode;
    messageHead += this._clientConfig.serviceType;
    messageHead += this._clientConfig.macAddress;
    messageHead += dateFormat(new Date(), this._clientConfig.dateTimeFormat);
    messageHead += this._clientConfig.defaultResponseCode;
    messageHead += Array(43).join(' '); // responseMessage, rspMsg
    messageHead += this._clientConfig.conFlag;
    messageHead += padString(this.messageBodyBuffer.length, 8, '0');
    messageHead += this._clientConfig.countId;
    messageHead += this._clientLogId;
    messageHead += this._clientConfig.marketId;

    return messageHead;
  }

  composeNetworkHead() {
    let networkHead = '';

    networkHead += 'A001130101';
    networkHead += this._clientConfig.marketId;
    networkHead += '                '; // Part 2, 16 spaces
    networkHead += padString(this.messageBodyBuffer.length, 10, '0');
    networkHead += '000000'; // Part 3, hTradeCode
    networkHead += this._clientConfig.countId; // Part 4, 7 digits total
    networkHead += this._clientConfig.serviceType;
    networkHead += dateFormat(new Date(), this._clientConfig.dateTimeFormat);
    networkHead += this._clientLogId;
    networkHead += this._clientConfig.defaultResponseCode; // Part 5, RspCode
    networkHead += Array(101).join(' '); // Part 6, RspMsg, 100 spaces
    networkHead += this._clientConfig.conFlag; // Part 7, 1 char
    networkHead += '000'; // Part 7, hTimes, 3 char
    networkHead += '0'; // Part 7, hSignFlag, 1 char
    networkHead += '0'; // Part 7, hSignPacketType, 1 char
    networkHead += Array(13).join(' '); // Part 7, netHeadPart3, 12 spaces
    networkHead += Array(12).join('0'); // Part 7, netHeadPart4, 11 0s

    return networkHead;
  }

  get functionCode() {
    return this._functionCode;
  }

  get paramsList() {
    return this._paramsList;
  }

  get messageBody() {
    if (!this._messageBody) {
      this._messageBody = this.composeMessageBody();
    }
    return this._messageBody;
  }

  get messageBodyBuffer() {
    if (!this._messageBodyBuffer) {
      this._messageBodyBuffer = gbkEncode(this.messageBody);
    }
    return this._messageBodyBuffer;
  }

  get messageHead() {
    if (this._messageHead) {
      this._messageHead = this.composeMessageHead();
    }
    return this._messageHead;
  }

  get networkHead() {
    if (this._networkHead) {
      this._networkHead = this.composeNetworkHead();
    }
    return this._networkHead;
  }

  get buffer() {
    var networkHeadBuffer = Buffer.from(this.networkHead);
    var messageHeadBuffer = Buffer.from(this.messageHead);

    const totalLength = networkHeadBuffer.length + messageHeadBuffer.length +
                        this.messageBodyBuffer.length;

    return Buffer.concat([networkHeadBuffer,
                          messageHeadBuffer,
                          this.messageBodyBuffer], totalLength);
  }
}

class RegulatoryResponse {
  constructor(responseBuffer) {
    
  }
}

export default class RegulatoryClient {
  constructor(config) {
    if (!('port' in config && 'server' in config && 'marketId' in config)) {
      throw new Error('[PINGAN] Cannot initialize retulatory client.');
    }
    // Set up Regulatory Client (见证宝)
    this._pool = new ConnectionPool(10, () => {
      return net.connect(config.port, config.server);
    }, {
      min: 100,
      max: 30000,
      retries: 3
    });

    this._clientConfig = {
      marketId: config.marketId, // qydm
      serviceType: config.serviceType || '01', // servType
      macAddress: config.macAddress || '                ', // macCode
      dateTimeFormat: config.dateTimeFormat || 'yyyyMMddHHmmss', // tranDateTime
      defaultResponseCode: config.defaultResponseCode || "999999", // RspCode
      conFlag: config.conFlag || "0",
      countId: config.countId || "PA001"
    };
  }

  sendMessage(clientLogId, functionCode, paramsList, callback) {
    var message = new RegulatoryMessage(this._clientConfig, clientLogId,
                                        functionCode, paramsList);

    this._pool.pull((err, connection) => {
      // Handles Error
      if (err) {
        callback(err, null);
        return;
      }

      // Sends message
      connection.write(message.buffer);
      console.log('Connection Initialized');
      connection.on('data', data => {
        callback(null, data.toString());
        connection.end();
      });

      // Disconnects message
      connection.on('end', () => {
        console.log('Connection Terminated');
      });
    });
  }
}

// TODO:
// Split Message
