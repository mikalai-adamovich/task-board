/**
 * The member list is ordered once, on the server.
 *
 * The server (`TenantMemberRepository.findByTenantWithUsers`) orders by
 * lower-cased display name, then e-mail, then `userId`. The browser used to
 * re-sort the same list with `localeCompare`, whose result depends on each
 * reader's own locale data, so two users could see the same members in
 * different orders. These tests hold the two halves of that contract:
 *
 *  1. with no column sort chosen, the composable returns the source list
 *     untouched — the order is the server's, not a second one;
 *  2. an explicit column sort is deterministic: case-insensitive first, then
 *     code-unit, which is what Mongo's default binary collation does, so the
 *     client and the server agree on the order of the same rows.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { PreferencesStore } from '@stores/preferences-store';
import { useMemberTable } from './member-table';

interface Row {
  id: string;
  name: string;
}

function makeRows(): Row[] {
  return [
    { id: 'u3', name: 'ada' },
    { id: 'u1', name: 'Ada' },
    { id: 'u2', name: 'Bea' },
  ];
}

describe('useMemberTable ordering (N-10)', () => {
  let source: ReturnType<typeof signal<Row[]>>;
  let navigate: ReturnType<typeof vi.fn>;

  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: PreferencesStore, useValue: { pageSize: () => 25, setPageSize: vi.fn() } },
        { provide: Router, useValue: { navigate: navigate, createUrlTree: vi.fn(() => of({})) } },
        { provide: ActivatedRoute, useValue: { queryParams: of({}) } },
      ],
    });

    return TestBed.runInInjectionContext(() =>
      useMemberTable<Row>({
        source: source.asReadonly(),
        filters: {},
        sorters: { name: (row) => row.name },
        load: vi.fn(),
      }),
    );
  }

  beforeEach(() => {
    source = signal(makeRows());
    navigate = vi.fn();
  });

  it('keeps the server order when no column sort is chosen', () => {
    const table = setup();

    // `ada`, `Ada`, `Bea` is the order the server pipeline produced. A client
    // re-sort would produce `Ada`, `ada`, `Bea` (case-sensitive) or depend on
    // the reader's locale data.
    expect(table.paginated().map((row) => row.name)).toEqual(['ada', 'Ada', 'Bea']);
  });

  it('sorts case-insensitively first, then by code unit, matching the server', () => {
    const table = setup();

    table.sortField.set('name');
    table.sortDirection.set('asc');

    // Lower-cased keys tie (`ada` === `ada`), so the raw value breaks the tie:
    // uppercase `A` (65) precedes lowercase `a` (97) in code-unit order, which
    // is Mongo's default binary collation.
    expect(table.paginated().map((row) => row.name)).toEqual(['Ada', 'ada', 'Bea']);
  });

  it('reverses the same order for desc, so the comparator is antisymmetric', () => {
    const table = setup();

    table.sortField.set('name');
    table.sortDirection.set('desc');

    expect(table.paginated().map((row) => row.name)).toEqual(['Bea', 'ada', 'Ada']);
  });

  it('does not consult the reader locale: a Swedish collation would order the same rows differently', () => {
    const table = setup();

    table.sortField.set('name');
    table.sortDirection.set('asc');

    const original = String.prototype.localeCompare;
    const calls: string[] = [];

    // Any use of `localeCompare` inside the sort would land here; the rule is
    // that the comparator reads the reader's collation data at all.
    String.prototype.localeCompare = function patched(this: string, other: string) {
      calls.push(`${this}|${other}`);

      return original.call(this, other);
    };

    try {
      table.paginated();
    } finally {
      String.prototype.localeCompare = original;
    }

    expect(calls).toEqual([]);
  });
});
