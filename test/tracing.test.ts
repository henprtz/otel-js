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

import * as assert from 'assert';
import * as sinon from 'sinon';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { diag } from '@opentelemetry/api';
import { ciscoTracing, Options } from '../src';
import * as utils from './utils';
import { ExporterOptions } from '../src/options';

describe('Tracing test', () => {
  let addSpanProcessorMock;
  const createLoggerStub = sinon.fake();

  beforeEach(() => {
    addSpanProcessorMock = sinon.stub(
      NodeTracerProvider.prototype,
      'addSpanProcessor'
    );
    diag.setLogger = createLoggerStub;

    utils.cleanEnvironmentVariables();
  });

  afterEach(() => {
    addSpanProcessorMock.restore();
    createLoggerStub.resetHistory();
  });

  function assertTracingPipeline(
    exportURL: string,
    serviceName: string,
    accessToken?: string
  ) {
    sinon.assert.calledOnce(addSpanProcessorMock);
    const processor = addSpanProcessorMock.getCall(0).args[0];

    assert(processor instanceof BatchSpanProcessor);
    const exporter = processor['_exporter'];
    assert(exporter instanceof OTLPGrpcTraceExporter);

    assert.deepEqual(exporter.url, exportURL);

    if (accessToken) {
      // gRPC not yet supported in ingest
      assert.equal(exporter?.metadata?.get('authorization'), accessToken);
    }
  }

  it('setups tracing with custom options', async () => {
    const userOptions: Partial<Options> = {
      serviceName: 'my-app-name',
      ciscoToken: 'cisco-token',
      debug: false,
      exporters: [
        <ExporterOptions>{
          collectorEndpoint: 'http://localhost:4317',
        },
      ],
    };
    await ciscoTracing.init(userOptions);
    assertTracingPipeline('localhost:4317', 'my-app-name', 'cisco-token');
  });

  it('setups tracing with defaults', async () => {
    const exporterOptions: ExporterOptions = {
      collectorEndpoint: '',
    };
    const userOptions = {
      serviceName: '',
      ciscoToken: '',
      exporters: [exporterOptions],
    };
    process.env.OTEL_COLLECTOR_ENDPOINT = exporterOptions.collectorEndpoint;
    process.env.OTEL_SERVICE_NAME = userOptions.serviceName;
    process.env.CISCO_TOKEN = userOptions.ciscoToken;

    await ciscoTracing.init(userOptions);
    sinon.assert.notCalled(addSpanProcessorMock);
  });
});
