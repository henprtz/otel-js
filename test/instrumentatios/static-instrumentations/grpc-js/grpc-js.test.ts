/*
 * Copyright The Cisco Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/*eslint sort-imports: ["error", { "ignoreDeclarationSort": true }]*/
import { GrpcJsInstrumentation } from '../../../../src/instrumentations/static-instrumentations/grpc-js/instrumentation';
const instrumentation = new GrpcJsInstrumentation('grpc-test-instrumentation', {
  maxPayloadSize: 10,
});
instrumentation.enable();
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as utils from '../../../utils';
import * as grpc from '@grpc/grpc-js';
import { server } from './server';
import { HelloRequest } from './generated_proto/hello_pb';
import { GreeterClient } from './generated_proto/hello_grpc_pb';
import { assertExpectedObj } from '../../../utils';
import {
  REQUEST_MESSAGE,
  REQUEST_METADATA,
  RESPONSE_MESSAGE,
  RESPONSE_METADATA,
} from './consts';
import assert = require('assert');

const SERVER_PORT = 51051;

const memoryExporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
instrumentation.setTracerProvider(provider);
provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));

describe('Capturing gRPC Metadata/Bodies', () => {
  const request = new HelloRequest();
  request.setName(REQUEST_MESSAGE);
  const client = new GreeterClient(
    `localhost:${SERVER_PORT}`,
    grpc.credentials.createInsecure()
  );
  before(done => {
    instrumentation.enable();
    server.bindAsync(
      `localhost:${SERVER_PORT}`,
      grpc.ServerCredentials.createInsecure(),
      () => {
        console.log('server listening');
        server.start();
        done();
      }
    );
  });

  beforeEach(done => {
    memoryExporter.reset();
    utils.cleanEnvironmentVariables();
    // we need to make the grpc call before the actual test because the client wrapper doesnt
    // end the span until after the callback function returns
    client.sayHello(request, REQUEST_METADATA, (err, response) => {
      if (err) throw err;
      done();
    });
  });

  after(() => {
    server.forceShutdown();
  });

  it('should capture request/response metadata & body', done => {
    const [serverSpan, clientSpan] = memoryExporter.getFinishedSpans();
    assertExpectedObj(
      serverSpan,
      REQUEST_METADATA.getMap(),
      'rpc.request.metadata'
    );
    assertExpectedObj(
      clientSpan,
      REQUEST_METADATA.getMap(),
      'rpc.request.metadata'
    );
    assertExpectedObj(
      clientSpan,
      RESPONSE_METADATA.getMap(),
      'rpc.response.metadata'
    );

    assert.strictEqual(
      serverSpan.attributes['rpc.request.body'],
      REQUEST_MESSAGE
    );

    assert.strictEqual(
      clientSpan.attributes['rpc.request.body'],
      REQUEST_MESSAGE
    );

    assert.strictEqual(
      serverSpan.attributes['rpc.response.body'],
      RESPONSE_MESSAGE
    );

    assert.strictEqual(
      clientSpan.attributes['rpc.response.body'],
      RESPONSE_MESSAGE
    );

    done();
  });
});