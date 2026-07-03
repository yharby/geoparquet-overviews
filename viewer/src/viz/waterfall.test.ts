import { describe, it, expect } from 'vitest';
import { RingBuffer } from './waterfall';

describe('RingBuffer', () => {
  it('returns pushed items oldest-first while under capacity', () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.length).toBe(3);
  });

  it('drops the oldest entry once capacity is exceeded', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // evicts 1
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.length).toBe(3);
  });

  it('keeps evicting the new oldest entry across many pushes past capacity', () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 0; i < 10; i++) buf.push(i);
    expect(buf.toArray()).toEqual([7, 8, 9]);
    expect(buf.length).toBe(3);
  });

  it('clear empties the buffer and resets it to accept fresh pushes from scratch', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.toArray()).toEqual([]);
    expect(buf.length).toBe(0);
    buf.push(9);
    expect(buf.toArray()).toEqual([9]);
  });

  it('supports a capacity of one, always keeping only the latest push', () => {
    const buf = new RingBuffer<string>(1);
    buf.push('a');
    buf.push('b');
    expect(buf.toArray()).toEqual(['b']);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow();
  });
});
