import { describe, expect, it } from 'vitest';
import { branchName, findForbidden, globToRegExp, slugify } from '../src/scope.js';

describe('findForbidden', () => {
  const patterns = ['.env', '.env.*', '**/*.pem', 'infra/secrets/**'];

  it('matches file-name patterns in any directory', () => {
    expect(findForbidden(['.env', 'api/.env', 'api/.env.production'], patterns)).toEqual([
      '.env',
      'api/.env',
      'api/.env.production',
    ]);
  });

  it('matches path patterns, including the root level for "**/"', () => {
    expect(findForbidden(['key.pem', 'certs/deep/key.pem', 'infra/secrets/a/b.json'], patterns)).toEqual([
      'key.pem',
      'certs/deep/key.pem',
      'infra/secrets/a/b.json',
    ]);
  });

  it('lets ordinary files through', () => {
    expect(findForbidden(['src/env.ts', 'docs/.envrc.md', 'infra/main.tf', 'README.md'], patterns)).toEqual([]);
  });
});

describe('globToRegExp', () => {
  it('keeps "*" inside one segment', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false);
  });

  it('escapes regexp characters', () => {
    expect(globToRegExp('a+b(1).txt').test('a+b(1).txt')).toBe(true);
    expect(globToRegExp('a.txt').test('abtxt')).toBe(false);
  });
});

describe('slugify / branchName', () => {
  it('removes accents and punctuation', () => {
    expect(slugify('Exportação em PDF: relatório (v2)!')).toBe('exportacao-em-pdf-relatorio-v2');
  });

  it('limits length without a trailing dash', () => {
    expect(slugify('a'.repeat(39) + ' bcd')).toBe('a'.repeat(39));
  });

  it('falls back when nothing is left', () => {
    expect(slugify('!!!')).toBe('request');
  });

  it('builds the agent branch name', () => {
    expect(branchName('agent/', 'REQ-7', 'Filtro por período')).toBe('agent/REQ-7-filtro-por-periodo');
  });
});
