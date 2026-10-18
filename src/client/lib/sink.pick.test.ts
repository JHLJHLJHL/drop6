// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { needsPicker, pickFileSystemSink } from './sink';

type PickerWindow = { showSaveFilePicker?: unknown };

afterEach(() => {
  delete (window as PickerWindow).showSaveFilePicker;
});

describe('needsPicker', () => {
  const MB = 1024 * 1024;
  const small = { name: 'a.bin', size: 10 * MB, mime: '' };
  const big = { name: 'b.bin', size: 600 * MB, mime: '' };
  const bundle = { name: 'z.zip', size: 700 * MB, mime: 'application/zip', files: [{ name: 'a', size: 300 * MB }, { name: 'b', size: 400 * MB }] };
  const withDialogs = () => {
    (window as PickerWindow).showSaveFilePicker = () => {};
  };

  it('never opens a dialog in a browser that has none', () => {
    expect(needsPicker(small, 'zip', true)).toBe(false);
    expect(needsPicker(big, 'zip', true)).toBe(false);
  });

  it('downloads straight into the downloads folder unless the user asked for a dialog', () => {
    withDialogs();
    expect(needsPicker(small, 'zip', false)).toBe(false);
    expect(needsPicker(small, 'zip', true)).toBe(true);
  });

  it('opens the dialog anyway for what is too big for the browser download', () => {
    withDialogs();
    expect(needsPicker(big, 'zip', false)).toBe(true);
    expect(needsPicker(bundle, 'zip', false)).toBe(true);
    expect(needsPicker(bundle, 'files', false)).toBe(false); // every file fits on its own
  });
});

describe('pickFileSystemSink', () => {
  it('opens the save dialog on the downloads folder with a safe suggested name', async () => {
    const writable = { write: async () => {}, close: async () => {}, abort: async () => {} };
    const picker = vi.fn().mockResolvedValue({ name: 'report.pdf', createWritable: async () => writable });
    (window as PickerWindow).showSaveFilePicker = picker;

    const picked = await pickFileSystemSink('../report.pdf');

    expect(picker).toHaveBeenCalledWith({ suggestedName: '.._report.pdf', startIn: 'downloads' });
    expect(picked?.savedName).toBe('report.pdf');
  });

  it('returns undefined when the user dismisses the dialog', async () => {
    (window as PickerWindow).showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException('dismissed', 'AbortError'));
    await expect(pickFileSystemSink('a.txt')).resolves.toBeUndefined();
  });

  it('rethrows other failures so the session can report a storage problem', async () => {
    (window as PickerWindow).showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException('blocked', 'SecurityError'));
    await expect(pickFileSystemSink('a.txt')).rejects.toThrow('blocked');
  });
});
