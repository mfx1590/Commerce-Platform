import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_GROUP, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults: group analytics.raw, its DLQ, ClickHouse on the shared stack port, long-running', () => {
    const c = loadConfig({}, []);
    expect(c.groupId).toBe(DEFAULT_GROUP);
    expect(c.dlqTopic).toBe('dlq.analytics.raw');
    expect(c.clickhouse.url).toBe('http://127.0.0.1:18123');
    expect(c.clickhouse.database).toBe('analytics');
    expect(c.once).toBe(false);
  });

  // #599: a group override must move the DLQ watch with it, whichever way it is given
  it('an env override moves the consumer group AND the DLQ topic', () => {
    const c = loadConfig({ ANALYTICS_GROUP_ID: 'analytics.raw.gate-7' }, []);
    expect(c.groupId).toBe('analytics.raw.gate-7');
    expect(c.dlqTopic).toBe('dlq.analytics.raw.gate-7');
  });

  it('a --group flag wins over the env, and in --once mode too', () => {
    const c = loadConfig({ ANALYTICS_GROUP_ID: 'analytics.raw.env' }, [
      '--once',
      '--group',
      'analytics.raw.flag',
    ]);
    expect(c.once).toBe(true);
    expect(c.groupId).toBe('analytics.raw.flag');
    expect(c.dlqTopic).toBe('dlq.analytics.raw.flag');
  });

  it('the topic prefix applies to the DLQ as well', () => {
    const c = loadConfig({}, ['--topic-prefix', 'it-42.']);
    expect(c.topicPrefix).toBe('it-42.');
    expect(c.dlqTopic).toBe('it-42.dlq.analytics.raw');
  });

  it('refuses an invalid group id and bad numbers', () => {
    expect(() => loadConfig({ ANALYTICS_GROUP_ID: 'Bad Group' }, [])).toThrow(ConfigError);
    expect(() => loadConfig({ ANALYTICS_BATCH_SIZE: '0' }, [])).toThrow(ConfigError);
    expect(() => loadConfig({}, ['--group'])).toThrow(ConfigError);
  });
});
