// Copyright 2015 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as jws from 'jws';
import * as LRU from 'lru-cache';
import * as stream from 'stream';

import * as messages from '../messages';
import {JWTInput} from './credentials';
import {Headers, RequestMetadataResponse} from './oauth2client';

const DEFAULT_HEADER: jws.Header = {
  alg: 'RS256',
  typ: 'JWT',
};

export interface Claims {
  [index: string]: string;
}

export class JWTAccess {
  email?: string | null;
  key?: string | null;
  keyId?: string | null;
  projectId?: string;

  private cache = new LRU<string, Headers>({max: 500, maxAge: 60 * 60 * 1000});

  /**
   * JWTAccess service account credentials.
   *
   * Create a new access token by using the credential to create a new JWT token
   * that's recognized as the access token.
   *
   * @param email the service account email address.
   * @param key the private key that will be used to sign the token.
   * @param keyId the ID of the private key used to sign the token.
   */
  constructor(
    email?: string | null,
    key?: string | null,
    keyId?: string | null
  ) {
    this.email = email;
    this.key = key;
    this.keyId = keyId;
  }

  /**
   * Get a non-expired access token, after refreshing if necessary.
   *
   * @param url The URI being authorized.
   * @param additionalClaims An object with a set of additional claims to
   * include in the payload.
   * @returns An object that includes the authorization header.
   */
  getRequestHeaders(url: string, additionalClaims?: Claims): Headers {
    const cachedToken = this.cache.get(url);
    if (cachedToken) {
      return cachedToken;
    }
    const iat = Math.floor(new Date().getTime() / 1000);
    const exp = iat + 3600; // 3600 seconds = 1 hour

    // The payload used for signed JWT headers has:
    // iss == sub == <client email>
    // aud == <the authorization uri>
    const defaultClaims = {
      iss: this.email,
      sub: this.email,
      aud: url,
      exp,
      iat,
    };

    // if additionalClaims are provided, ensure they do not collide with
    // other required claims.
    if (additionalClaims) {
      for (const claim in defaultClaims) {
        if (additionalClaims[claim]) {
          throw new Error(
            `The '${claim}' property is not allowed when passing additionalClaims. This claim is included in the JWT by default.`
          );
        }
      }
    }

    const header = this.keyId
      ? {...DEFAULT_HEADER, kid: this.keyId}
      : DEFAULT_HEADER;
    const payload = Object.assign(defaultClaims, additionalClaims);

    // Sign the jwt and add it to the cache
    const signedJWT = jws.sign({header, payload, secret: this.key});
    const headers = {Authorization: `Bearer ${signedJWT}`};
    this.cache.set(url, headers);
    return headers;
  }

  /**
   * Create a JWTAccess credentials instance using the given input options.
   * @param json The input object.
   */
  fromJSON(json: JWTInput): void {
    if (!json) {
      throw new Error(
        'Must pass in a JSON object containing the service account auth settings.'
      );
    }
    if (!json.client_email) {
      throw new Error(
        'The incoming JSON object does not contain a client_email field'
      );
    }
    if (!json.private_key) {
      throw new Error(
        'The incoming JSON object does not contain a private_key field'
      );
    }
    // Extract the relevant information from the json key file.
    this.email = json.client_email;
    this.key = json.private_key;
    this.keyId = json.private_key_id;
    this.projectId = json.project_id;
  }

  /**
   * Create a JWTAccess credentials instance using the given input stream.
   * @param inputStream The input stream.
   * @param callback Optional callback.
   */
  fromStream(inputStream: stream.Readable): Promise<void>;
  fromStream(
    inputStream: stream.Readable,
    callback: (err?: Error) => void
  ): void;
  fromStream(
    inputStream: stream.Readable,
    callback?: (err?: Error) => void
  ): void | Promise<void> {
    if (callback) {
      this.fromStreamAsync(inputStream).then(r => callback(), callback);
    } else {
      return this.fromStreamAsync(inputStream);
    }
  }

  private fromStreamAsync(inputStream: stream.Readable): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!inputStream) {
        reject(
          new Error(
            'Must pass in a stream containing the service account auth settings.'
          )
        );
      }
      let s = '';
      inputStream
        .setEncoding('utf8')
        .on('data', chunk => (s += chunk))
        .on('error', reject)
        .on('end', () => {
          try {
            const data = JSON.parse(s);
            this.fromJSON(data);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
    });
  }
}
