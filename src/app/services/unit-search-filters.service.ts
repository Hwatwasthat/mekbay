/*
 * Copyright (C) 2025 The MegaMek Team. All Rights Reserved.
 *
 * This file is part of MekBay.
 *
 * MekBay is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License (GPL),
 * version 3 or (at your option) any later version,
 * as published by the Free Software Foundation.
 *
 * MekBay is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty
 * of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 * A copy of the GPL should have been included with this project;
 * if not, see <https://www.gnu.org/licenses/>.
 *
 * NOTICE: The MegaMek organization is a non-profit group of volunteers
 * creating free software for the BattleTech community.
 *
 * MechWarrior, BattleMech, `Mech and AeroTech are registered trademarks
 * of The Topps Company, Inc. All Rights Reserved.
 *
 * Catalyst Game Labs and the Catalyst Game Labs logo are trademarks of
 * InMediaRes Productions, LLC.
 *
 * MechWarrior Copyright Microsoft Corporation. MegaMek was created under
 * Microsoft's "Game Content Usage Rules"
 * <https://www.xbox.com/en-US/developers/rules> and it is not endorsed by or
 * affiliated with Microsoft.
 */

import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { Unit } from '../models/units.model';
import { DataService } from './data.service';
import { MultiState, MultiStateSelection } from '../components/multi-select-dropdown/multi-select-dropdown.component';
import { ActivatedRoute, Router } from '@angular/router';
import { BVCalculatorUtil } from '../utils/bv-calculator.util';

/*
 * Author: Drake
 */
export interface SortOption {
    key: string;
    label: string;    
    slotLabel?: string; // Optional label prefix to show in the slot (e.g., "BV")
    slotIcon?: string;  // Optional icon for the slot (e.g., '/images/calendar.svg')

}

export enum AdvFilterType {
    DROPDOWN = 'dropdown',
    RANGE = 'range'
}
export interface AdvFilterConfig {
    key: string;
    label: string;
    type: AdvFilterType;
    sortOptions?: string[]; // For dropdowns, can be pre-defined sort order, supports wildcard '*' at the end for prefix matching
    external?: boolean; // If true, this filter datasource is not from the local data, but from an external source (era, faction, etc.)
    curve?: number; // for range sliders, defines the curve of the slider
    ignoreValues?: any[]; // Values to ignore in the range filter, e.g. [-1] for heat/dissipation
    multistate?: boolean; // if true, the filter (dropdown) can have multiple states (OR, AND, NOT)
    countable?: boolean; // if true, show amount next to options
}

interface FilterState {
    [key: string]: {
        value: any;
        interactedWith: boolean;
    };
}

type DropdownFilterOptions = {
    type: 'dropdown';
    label: string;
    options: { name: string, img?: string }[];
    value: string[];
    interacted: boolean;
};

type RangeFilterOptions = {
    type: 'range';
    label: string;
    totalRange: [number, number];
    options: [number, number];
    value: [number, number];
    interacted: boolean;
    curve?: number;
};

type AdvFilterOptions = DropdownFilterOptions | RangeFilterOptions;

const DEFAULT_FILTER_CURVE = 0;
export const FACTION_EXTINCT = 3;

function smartDropdownSort(options: string[], predefinedOrder?: string[]): string[] {
    if (predefinedOrder && predefinedOrder.length > 0) {
        const optionsSet = new Set(options);
        const sortedOptions: string[] = [];
        for (const predefinedOpt of predefinedOrder) {
            if (predefinedOpt.endsWith('*')) {
                const prefix = predefinedOpt.slice(0, -1);
                // Smart sort for matching options
                const matchingOptions = Array.from(optionsSet)
                    .filter(o => typeof o === 'string' && o.startsWith(prefix))
                    .sort((a, b) => naturalCompare(a, b));
                for (const match of matchingOptions) {
                    sortedOptions.push(match);
                    optionsSet.delete(match);
                }
            } else if (optionsSet.has(predefinedOpt)) {
                sortedOptions.push(predefinedOpt);
                optionsSet.delete(predefinedOpt);
            }
        }
        const remainingSorted = Array.from(optionsSet).sort(naturalCompare);
        return [...sortedOptions, ...remainingSorted];
    }
    return options.sort(naturalCompare);
}

function naturalCompare(a: string, b: string): number {
    const regex = /^([^\d]*)(\d+)?(.*)$/;
    const matchA = a.match(regex);
    const matchB = b.match(regex);

    const prefixA = matchA ? (matchA[1] + (matchA[3] || '')).trim() : a;
    const prefixB = matchB ? (matchB[1] + (matchB[3] || '')).trim() : b;
    const numA = matchA && matchA[2] ? parseInt(matchA[2], 10) : NaN;
    const numB = matchB && matchB[2] ? parseInt(matchB[2], 10) : NaN;

    if (prefixA === prefixB) {
        if (!isNaN(numA) && !isNaN(numB)) {
            return numA - numB;
        }
        if (!isNaN(numA)) return -1;
        if (!isNaN(numB)) return 1;
        return a.localeCompare(b);
    }
    return prefixA.localeCompare(prefixB);
}


function filterUnitsByMultiState(units: Unit[], key: string, selection: MultiStateSelection): Unit[] {
    const orList: Array<{name: string, count: number}> = [];
    const andList: Array<{name: string, count: number}> = [];
    const notSet = new Set<string>();
    
    for (const [name, selectionValue] of Object.entries(selection)) {
        const { state, count } = selectionValue;
        if (state === 'or') orList.push({ name, count });
        else if (state === 'and') andList.push({ name, count });
        else if (state === 'not') notSet.add(name);
    }

    // Early return if no filters
    if (orList.length === 0 && andList.length === 0 && notSet.size === 0) {
        return units;
    }
    
    const needsQuantityCounting = [...orList, ...andList].some(item => item.count > 1);
    const isComponentFilter = key === 'componentName';

    // Pre-create Sets for faster lookup
    const orMap = new Map(orList.map(item => [item.name, item.count]));
    const andMap = new Map(andList.map(item => [item.name, item.count]));

    return units.filter(unit => {
        let unitData: { names: Set<string>; counts?: Map<string, number> };

         if (isComponentFilter) {
            // Use cached component data for performance
            const cached = getUnitComponentData(unit);
            unitData = {
                names: cached.componentNames,
                counts: needsQuantityCounting ? cached.componentCounts : undefined
            };
        } else {
            const propValue = (unit as any)[key];
            const unitValues = Array.isArray(propValue) ? propValue : [propValue];
            const names = new Set(unitValues.filter(v => v != null));
            
            unitData = { names };
            if (needsQuantityCounting) {
                const counts = new Map<string, number>();
                for (const value of unitValues) {
                    if (value != null) {
                        counts.set(value, (counts.get(value) || 0) + 1);
                    }
                }
                unitData.counts = counts;
            }
        }
        
        if (notSet.size > 0) {
            for (const notName of notSet) {
                if (unitData.names.has(notName)) return false;
            }
        }

        // AND: Must have all items with sufficient quantity
        if (andMap.size > 0) {
            if (needsQuantityCounting && unitData.counts) {
                for (const [name, requiredCount] of andMap) {
                    if ((unitData.counts.get(name) || 0) < requiredCount) return false;
                }
            } else {
                for (const [name] of andMap) {
                    if (!unitData.names.has(name)) return false;
                }
            }
        }

        // OR: Must have at least one with sufficient quantity
        if (orMap.size > 0) {
            if (needsQuantityCounting && unitData.counts) {
                for (const [name, requiredCount] of orMap) {
                    if ((unitData.counts.get(name) || 0) >= requiredCount) {
                        return true;
                    }
                }
                return false;
            } else {
                for (const [name] of orMap) {
                    if (unitData.names.has(name)) {
                        return true;
                    }
                }
                return false;
            }
        }

        return true;
    });
}

export const ADVANCED_FILTERS: AdvFilterConfig[] = [
    { key: 'era', label: 'Era', type: AdvFilterType.DROPDOWN, external: true },
    { key: 'faction', label: 'Faction', type: AdvFilterType.DROPDOWN, external: true },
    { key: 'type', label: 'Type', type: AdvFilterType.DROPDOWN },
    { key: 'subtype', label: 'Subtype', type: AdvFilterType.DROPDOWN },
    {
        key: 'techBase', label: 'Tech', type: AdvFilterType.DROPDOWN,
        sortOptions: ['Inner Sphere', 'Clan', 'Mixed']
    },
    { key: 'role', label: 'Role', type: AdvFilterType.DROPDOWN },
    {
        key: 'weightClass', label: 'Weight Class', type: AdvFilterType.DROPDOWN,
        sortOptions: ['Ultra Light*', 'Light', 'Medium', 'Heavy', 'Assault', 'Colossal*', 'Small*', 'Medium*', 'Large*']
    },
    {
        key: 'level', label: 'Rules', type: AdvFilterType.DROPDOWN,
        sortOptions: ['Introductory', 'Standard', 'Advanced', 'Experimental', 'Unofficial']
    },
    { key: 'c3', label: 'Network', type: AdvFilterType.DROPDOWN },
    { key: 'moveType', label: 'Motive', type: AdvFilterType.DROPDOWN },
    { key: 'componentName', label: 'Equipment', type: AdvFilterType.DROPDOWN, multistate: true, countable: true },
    { key: 'quirks', label: 'Quirks', type: AdvFilterType.DROPDOWN, multistate: true },
    { key: 'source', label: 'Source', type: AdvFilterType.DROPDOWN },
    { key: '_tags', label: 'Tags', type: AdvFilterType.DROPDOWN, multistate: true },
    { key: 'bv', label: 'BV', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE },
    { key: 'tons', label: 'Tons', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE },
    // { key: 'pv', label: 'PV', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE },
    { key: 'armor', label: 'Armor', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE },
    { key: 'internal', label: 'Structure / Squad Size', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE },
    { key: '_mdSumNoPhysical', label: 'Firepower', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE },
    { key: 'dpt', label: 'Damage/Turn', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE },
    { key: 'heat', label: 'Total Weapons Heat', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE, ignoreValues: [-1] },
    { key: 'dissipation', label: 'Dissipation', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE, ignoreValues: [-1] },
    { key: '_maxRange', label: 'Range', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE },
    { key: 'walk', label: 'Walk MP', type: AdvFilterType.RANGE, curve: 0.9 },
    { key: 'run', label: 'Run MP', type: AdvFilterType.RANGE, curve: 0.9 },
    { key: 'jump', label: 'Jump MP', type: AdvFilterType.RANGE, curve: 0.9 },
    { key: 'year', label: 'Year', type: AdvFilterType.RANGE, curve: 1 },
    { key: 'cost', label: 'Cost', type: AdvFilterType.RANGE, curve: DEFAULT_FILTER_CURVE },
];

export const SORT_OPTIONS: SortOption[] = [
    { key: 'name', label: 'Name' },
    ...ADVANCED_FILTERS
        .filter(f => !['era', 'faction', 'componentName', 'source'].includes(f.key))
        .map(f => ({ 
            key: f.key, 
            label: f.label,
            slotLabel: f.label,
            // slotIcon: f.slotIcon
        }))
];

const unitComponentCache = new WeakMap<Unit, {
    componentNames: Set<string>;
    componentCounts: Map<string, number>;
}>();

function getUnitComponentData(unit: Unit) {
    let cached = unitComponentCache.get(unit);
    if (!cached) {
        const componentNames = new Set<string>();
        const componentCounts = new Map<string, number>();
        
        for (const component of unit.comp) {
            const name = component.n;
            componentNames.add(name);
            componentCounts.set(name, (componentCounts.get(name) || 0) + component.q);
        }
        
        cached = { componentNames, componentCounts };
        unitComponentCache.set(unit, cached);
    }
    return cached;
}

@Injectable({ providedIn: 'root' })
export class UnitSearchFiltersService {
    public dataService = inject(DataService);
    private router = inject(Router);
    private route = inject(ActivatedRoute);
    
    ADVANCED_FILTERS = ADVANCED_FILTERS;
    pilotGunnerySkill = signal(4);
    pilotPilotingSkill = signal(5);
    search = signal('');
    filterState = signal<FilterState>({});
    selectedSort = signal<string>('name');
    selectedSortDirection = signal<'asc' | 'desc'>('asc');
    expandedView = signal(false);
    advOpen = signal(false);
    private totalRangesCache: Record<string, [number, number]> = {};
    private availableNamesCache = new Map<string, string[]>();
    private urlStateInitialized = false;
    private tagsCacheKey = signal('');

    constructor() {
        effect(() => {
            if (this.isDataReady()) {
                this.calculateTotalRanges();
            }
        });
        effect(() => {
            const gunnery = this.pilotGunnerySkill();
            const piloting = this.pilotPilotingSkill();
            
            if (this.isDataReady() && this.advOptions()['bv']) {
                this.recalculateBVRange();
            }
        });
        this.loadFiltersFromUrlOnStartup();
        this.updateUrlOnFiltersChange();
    }

    dynamicInternalLabel = computed(() => {
        const units = this.filteredUnits();
        if (units.length === 0) return 'Structure / Squad Size';
        const hasInfantry = units.some(u => u.type === 'Infantry');
        const hasNonInfantry = units.some(u => u.type !== 'Infantry');
        if (hasInfantry && !hasNonInfantry) return 'Squad Size';
        if (!hasInfantry) return 'Structural Integrity';
        return 'Structure / Squad Size';
    });

    
    private recalculateBVRange() {
        const units = this.units;
        if (units.length === 0) return;

        const bvValues = units
            .map(u => this.getAdjustedBV(u))
            .filter(bv => bv > 0)
            .sort((a, b) => a - b);

        if (bvValues.length === 0) return;

        const min = bvValues[0];
        const max = bvValues[bvValues.length - 1];

        // Update the totalRangesCache which the computed signal depends on
        this.totalRangesCache['bv'] = [min, max];
        
        // Adjust current filter value to fit within new range if it exists
        const currentFilter = this.filterState()['bv'];
        if (currentFilter?.interactedWith) {
            const currentValue = currentFilter.value as [number, number];
            const adjustedValue: [number, number] = [
                Math.max(min, currentValue[0]),
                Math.min(max, currentValue[1])
            ];
            
            // Only update if the value actually changed
            if (adjustedValue[0] !== currentValue[0] || adjustedValue[1] !== currentValue[1]) {
                this.setFilter('bv', adjustedValue);
            }
        }
    }

    private calculateTotalRanges() {
        const rangeFilters = ADVANCED_FILTERS.filter(f => f.type === AdvFilterType.RANGE);
        for (const conf of rangeFilters) {
            if (conf.key === 'bv') {
                // Special handling for BV to use adjusted values
                const bvValues = this.units
                    .map(u => this.getAdjustedBV(u))
                    .filter(bv => bv > 0);
                if (bvValues.length > 0) {
                    this.totalRangesCache['bv'] = [Math.min(...bvValues), Math.max(...bvValues)];
                } else {
                    this.totalRangesCache['bv'] = [0, 0];
                }
            } else {
                const allValues = this.getValidFilterValues(this.units, conf);
                if (allValues.length > 0) {
                    this.totalRangesCache[conf.key] = [Math.min(...allValues), Math.max(...allValues)];
                } else {
                    this.totalRangesCache[conf.key] = [0, 0];
                }
            }
        }
    }

    get isDataReady() { return this.dataService.isDataReady; }
    get units() { return this.isDataReady() ? this.dataService.getUnits() : []; }

    public setSortOrder(key: string) {
        this.selectedSort.set(key);
    }

    public setSortDirection(direction: 'asc' | 'desc') {
        this.selectedSortDirection.set(direction);
    }

    private getUnitIdsForSelectedEras(selectedEraNames: string[]): Set<number> | null {
        if (!selectedEraNames || selectedEraNames.length === 0) return null;
        const unitIds = new Set<number>();
    
        const extinctFaction = this.dataService.getFactions().find(f => f.id === FACTION_EXTINCT);
        
        for (const eraName of selectedEraNames) {
            const era = this.dataService.getEraByName(eraName);
            if (era) {
                const extinctUnitIdsForEra = extinctFaction?.eras[era.id] as Set<number> || new Set<number>();
                (era.units as Set<number>).forEach(id => {
                    if (!extinctUnitIdsForEra.has(id)) {
                        unitIds.add(id);
                    }
                });
            }
        }
        return unitIds;
    }

    private getUnitIdsForSelectedFactions(selectedFactionNames: string[], contextEraIds?: Set<number>): Set<number> | null {
        if (!selectedFactionNames || selectedFactionNames.length === 0) return null;
        const unitIds = new Set<number>();
        for (const factionName of selectedFactionNames) {
            const faction = this.dataService.getFactionByName(factionName);
            if (faction) {
                for (const eraIdStr in faction.eras) {
                    const eraId = Number(eraIdStr);
                    if (!contextEraIds || contextEraIds.has(eraId)) {
                        (faction.eras[eraId] as Set<number>).forEach(id => unitIds.add(id));
                    }
                }
            }
        }
        return unitIds;
    }

    private applyFilters(units: Unit[], state: FilterState): Unit[] {
        let results = units;
        const activeFilters = Object.entries(state)
            .filter(([, s]) => s.interactedWith)
            .reduce((acc, [key, s]) => ({ ...acc, [key]: s.value }), {} as Record<string, any>);


        // Handle external (ID-based) filters first
        const selectedEraNames = activeFilters['era'] as string[] || [];
        const selectedFactionNames = activeFilters['faction'] as string[] || [];

        let eraUnitIds: Set<number> | null = null;
        let factionUnitIds: Set<number> | null = null;
        if (selectedFactionNames.length > 0) {
            const selectedEraIds = new Set(this.dataService.getEras().filter(e => selectedEraNames.includes(e.name)).map(e => e.id));
            factionUnitIds = this.getUnitIdsForSelectedFactions(selectedFactionNames, selectedEraIds.size > 0 ? selectedEraIds : undefined);
        } else
        if (selectedEraNames.length > 0) {
            eraUnitIds = this.getUnitIdsForSelectedEras(selectedEraNames);
        }

        if (eraUnitIds || factionUnitIds) {
            let finalIds: Set<number> | null;
            if (eraUnitIds && factionUnitIds) {
                finalIds = new Set([...eraUnitIds].filter(id => factionUnitIds!.has(id)));
            } else {
                finalIds = eraUnitIds || factionUnitIds;
            }
            results = results.filter(u => finalIds!.has(u.id));
        }

        // Handle standard (property-based) filters
        for (const conf of ADVANCED_FILTERS) {
            if (conf.external) continue;

            const filterState = state[conf.key];
            // Only apply filter if it has been interacted with
            if (!filterState || !filterState.interactedWith) continue;

            const val = filterState.value;
            
            if (conf.type === AdvFilterType.DROPDOWN && conf.multistate && val && typeof val === 'object') {
                results = filterUnitsByMultiState(results, conf.key, val);
                continue;
            }
            
            if (conf.type === AdvFilterType.DROPDOWN && Array.isArray(val) && val.length > 0) {
                results = results.filter(u => val.includes((u as any)[conf.key]));
                continue;
            }

            if (conf.type === AdvFilterType.RANGE && Array.isArray(val)) {
                // Special handling for BV range to use adjusted values
                if (conf.key === 'bv') {
                    results = results.filter(u => {
                        const adjustedBV = this.getAdjustedBV(u);
                        return adjustedBV >= val[0] && adjustedBV <= val[1];
                    });
                } else {
                    results = results.filter(u => {
                        const unitValue = (u as any)[conf.key];
                        if (conf.ignoreValues && conf.ignoreValues.includes(unitValue)) 
                        {
                            if (val[0] === 0) return true; // If the range starts at 0, we allow -1 values
                            return false; // Ignore this unit if it has an ignored value
                        }
                        return unitValue != null && unitValue >= val[0] && unitValue <= val[1];
                    });
                }
                continue;
            }
        }
        return results;
    }

    // All filters applied
    filteredUnits = computed(() => {
        if (!this.isDataReady()) return [];

        let results = this.units;
        const query = this.search().trim().toLowerCase();
        if (query) {
            // Split by commas or semicolons for OR logic
            const orGroups = query.split(/[,;]/).map(g => g.trim()).filter(Boolean);
            
            results = results.filter(unit => {
                // Unit matches if it matches ANY of the OR groups
                return orGroups.some(group => {
                    const words = Array.from(new Set(
                        group.split(/\s+/).filter(Boolean).map(w => DataService.removeAccents(w))
                    )).sort((a, b) => b.length - a.length);
                    return this.matchesWords(unit, words);
                });
            });
        }

        results = this.applyFilters(results, this.filterState());

        const sortKey = this.selectedSort();
        const sortDirection = this.selectedSortDirection();

        results.sort((a: Unit, b: Unit) => {
            let comparison = 0;
            if (sortKey === 'name') {
                comparison = (a.chassis || '').localeCompare(b.chassis || '');
                if (comparison === 0) {
                    comparison = (a.model || '').localeCompare(b.model || '');
                    if (comparison === 0) {
                        comparison = (a.year || 0) - (b.year || 0);
                    }
                }
            } else
            if (sortKey === 'bv') {
                // Use adjusted BV for sorting
                const aBv = this.getAdjustedBV(a);
                const bBv = this.getAdjustedBV(b);
                comparison = aBv - bBv;
            } else
            if (sortKey in a && sortKey in b) {
                const key = sortKey as keyof Unit;
                const aValue = a[key];
                const bValue = b[key];
                if (typeof aValue === 'string' && typeof bValue === 'string') {
                    comparison = aValue.localeCompare(bValue);
                }
                if (typeof aValue === 'number' && typeof bValue === 'number') {
                    comparison = aValue - bValue;
                }
            }
            if (sortDirection === 'desc') {
                return -comparison;
            }
            return comparison;
        });

        return results;
    });

    // Advanced filter options
    advOptions = computed(() => {
        if (!this.isDataReady()) return {};

        const result: Record<string, AdvFilterOptions> = {};
        const state = this.filterState();
        const _tagsCacheKey = this.tagsCacheKey();

        let baseUnits = this.units;
        const query = this.search().trim().toLowerCase();
        if (query) {
            
            // Split by commas or semicolons for OR logic
            const orGroups = query.split(/[,;]/).map(g => g.trim()).filter(Boolean);
            
            baseUnits = baseUnits.filter(unit => {
                // Unit matches if it matches ANY of the OR groups
                return orGroups.some(group => {
                    const words = Array.from(new Set(
                        group.split(/\s+/).filter(Boolean).map(w => DataService.removeAccents(w))
                    )).sort((a, b) => b.length - a.length);
                    return this.matchesWords(unit, words);
                });
            });
        }

        const activeFilters = Object.entries(state)
            .filter(([, s]) => s.interactedWith)
            .reduce((acc, [key, s]) => ({ ...acc, [key]: s.value }), {} as Record<string, any>);

        const selectedEraNames = activeFilters['era'] as string[] || [];
        const selectedFactionNames = activeFilters['faction'] as string[] || [];

        for (const conf of ADVANCED_FILTERS) {
            let label = conf.label;
            if (conf.key === 'internal') {
                label = this.dynamicInternalLabel();
            }
            const contextState = { ...state };
            delete contextState[conf.key];
            let contextUnits = this.applyFilters(baseUnits, contextState);

            if (conf.multistate && conf.type === AdvFilterType.DROPDOWN) {
                const isComponentFilter = conf.key === 'componentName';
                const isTagsFilter = conf.key === '_tags';
                const currentFilter = state[conf.key];
                const hasQuantityFilters = conf.countable && isComponentFilter
                    && currentFilter?.interactedWith && currentFilter.value &&
                    Object.values(currentFilter.value as MultiStateSelection).some(selection => selection.count > 1);

                const namesCacheKey = isTagsFilter 
                    ? `${conf.key}-${contextUnits.length}-${JSON.stringify(currentFilter?.value || {})}-${_tagsCacheKey}`
                    : `${conf.key}-${contextUnits.length}-${JSON.stringify(currentFilter?.value || {})}`;
                
                let availableNames = this.availableNamesCache.get(namesCacheKey);
                if (!availableNames) {
                    // Collect unique values efficiently
                    const nameSet = new Set<string>();
                    
                    if (isComponentFilter) {
                        for (const unit of contextUnits) {
                            for (const component of unit.comp) {
                                nameSet.add(component.n);
                            }
                        }
                    } else {
                        for (const unit of contextUnits) {
                            const propValue = (unit as any)[conf.key];
                            const values = Array.isArray(propValue) ? propValue : [propValue];
                            for (const value of values) {
                                if (value) nameSet.add(value);
                            }
                        }
                    }
                    
                    availableNames = Array.from(nameSet);
                    this.availableNamesCache.set(namesCacheKey, availableNames);
                }

                let filteredAvailableNames = availableNames;
                
                if (currentFilter?.interactedWith && currentFilter.value) {
                    const selection = currentFilter.value as MultiStateSelection;
                    const andEntries = Object.entries(selection).filter(([_, sel]) => sel.state === 'and');
                    
                    if (andEntries.length > 0) {
                        const andMap = new Map(andEntries.map(([name, sel]) => [name, sel.count]));
                        const notSet = new Set(
                            Object.entries(selection)
                                .filter(([_, sel]) => sel.state === 'not')
                                .map(([name]) => name)
                        );
                        
                        // Pre-filter units that satisfy AND conditions
                        const validUnits = contextUnits.filter(unit => {
                            if (isComponentFilter) {
                                const cached = getUnitComponentData(unit);
                                
                                // Check NOT conditions
                                for (const notName of notSet) {
                                    if (cached.componentNames.has(notName)) return false;
                                }
                                
                                // Check AND conditions
                                for (const [name, requiredCount] of andMap) {
                                    if ((cached.componentCounts.get(name) || 0) < requiredCount) return false;
                                }
                            } else {
                                // Handle other properties (simplified for brevity)
                                const propValue = (unit as any)[conf.key];
                                const values = Array.isArray(propValue) ? propValue : [propValue];
                                const valueSet = new Set(values);
                                
                                for (const notName of notSet) {
                                    if (valueSet.has(notName)) return false;
                                }
                                
                                for (const [name] of andMap) {
                                    if (!valueSet.has(name)) return false;
                                }
                            }
                            return true;
                        });
                        
                        // Collect available names from valid units
                        const filteredNameSet = new Set<string>();
                        for (const unit of validUnits) {
                            if (isComponentFilter) {
                                for (const component of unit.comp) {
                                    filteredNameSet.add(component.n);
                                }
                            } else {
                                const propValue = (unit as any)[conf.key];
                                const values = Array.isArray(propValue) ? propValue : [propValue];
                                for (const value of values) {
                                    if (value) filteredNameSet.add(value);
                                }
                            }
                        }
                        filteredAvailableNames = Array.from(filteredNameSet);
                    }
                }
            
            const sortedNames = smartDropdownSort(availableNames);
            const filteredSet = new Set(filteredAvailableNames);
            
            // Create options with availability flag and count
            const optionsWithAvailability = sortedNames.map(name => {
                const option: { name: string; available: boolean; count?: number } = {
                    name,
                    available: filteredSet.has(name)
                };
                
                // Add count only if needed and for component filters
                if (hasQuantityFilters) {
                    let totalCount = 0;
                    for (const unit of contextUnits) {
                        const cached = getUnitComponentData(unit);
                        totalCount += cached.componentCounts.get(name) || 0;
                    }
                    option.count = totalCount;
                }
                
                return option;
            });

            result[conf.key] = {
                type: 'dropdown',
                label,
                options: optionsWithAvailability,
                value: state[conf.key]?.interactedWith ? state[conf.key].value : {},
                interacted: state[conf.key]?.interactedWith ?? false
            };
            continue;
        }
        if (conf.type === AdvFilterType.DROPDOWN) {
            let availableOptions: { name: string, img?: string }[] = [];
            if (conf.external) {
                const contextUnitIds = new Set(contextUnits.filter(u => u.id !== -1).map(u => u.id));
                if (conf.key === 'era') {
                    const selectedFactionsAvailableEraIds: Set<number> = new Set(
                        this.dataService.getFactions()
                            .filter(faction => selectedFactionNames.includes(faction.name))
                            .flatMap(faction => Object.keys(faction.eras).map(Number))
                    );
                    availableOptions = this.dataService.getEras()
                        .filter(era => {
                            if (selectedFactionsAvailableEraIds.size > 0) {
                                if (!selectedFactionsAvailableEraIds.has(era.id)) return false;
                            }
                            return [...(era.units as Set<number>)].some(id => contextUnitIds.has(id))
                        }).map(era => ({ name: era.name, img: era.img }));
                } else 
                if (conf.key === 'faction') {
                    const selectedEraIds: Set<number> = new Set(this.dataService.getEras().filter(e => selectedEraNames.includes(e.name)).map(e => e.id));
                    availableOptions = this.dataService.getFactions()
                        .filter(faction => {
                            for (const eraIdStr in faction.eras) {
                                if (selectedEraIds.size > 0) {
                                    if (!selectedEraIds.has(Number(eraIdStr))) continue;
                                }
                                if ([...(faction.eras[eraIdStr] as Set<number>)].some(id => contextUnitIds.has(id))) return true;
                            }
                            return false;
                        })
                        .map(faction => ({ name: faction.name, img: faction.img }));
                }
            } else {
                const allOptions = Array.from(new Set(contextUnits.map(u => (u as any)[conf.key]).filter(v => v != null && v !== '')));
                const sortedOptions = smartDropdownSort(allOptions, conf.sortOptions);
                availableOptions = sortedOptions.map(name => ({ name }));
            }
            result[conf.key] = {
                type: 'dropdown',
                label,
                options: availableOptions,
                value: state[conf.key]?.interactedWith ? state[conf.key].value : [],
                interacted: state[conf.key]?.interactedWith ?? false
            };
        } else if (conf.type === AdvFilterType.RANGE) {
            const totalRange = this.totalRangesCache[conf.key] || [0, 0];
            
            // Special handling for BV to use adjusted values
            let vals: number[];
            if (conf.key === 'bv') {
                vals = contextUnits
                    .map(u => this.getAdjustedBV(u))
                    .filter(bv => bv > 0);
            } else {
                vals = this.getValidFilterValues(contextUnits, conf);
            }
            
            const availableRange = vals.length ? [Math.min(...vals), Math.max(...vals)] : totalRange;

            let currentValue = state[conf.key]?.interactedWith ? state[conf.key].value : availableRange;

            // Clamp both min and max to the available range, and ensure min <= max
            let clampedMin = Math.max(availableRange[0], Math.min(currentValue[0], availableRange[1]));
            let clampedMax = Math.min(availableRange[1], Math.max(currentValue[1], availableRange[0]));
            if (clampedMin > clampedMax) [clampedMin, clampedMax] = [clampedMax, clampedMin];
            currentValue = [clampedMin, clampedMax];

            result[conf.key] = {
                type: 'range',
                label,
                totalRange: totalRange,
                options: availableRange as [number, number],
                value: currentValue,
                interacted: state[conf.key]?.interactedWith ?? false
            };
        }
    }
    return result;
});

    /**
     * Checks if a unit chassis/model matches all the given words.
     * @param unit The unit to check.
     * @param words The words to match against the unit's properties, they must be sorted from longest to shortest
     * @returns True if the unit matches all words, false otherwise.
     */
    private matchesWords(unit: Unit, words: string[]): boolean {
        if (!words || words.length === 0) return true;
        const text = `${unit._chassis ?? ''} ${unit._model ?? ''}`;
        return this.tokensMatchNonOverlapping(text, words);
    }

    private tokensMatchNonOverlapping(text: string, tokens: string[]): boolean {
        const hay = text;
        const taken: Array<[number, number]> = [];
        for (const token of tokens) {
            if (!token) continue;
            let start = 0;
            let found = false;
            while (start <= hay.length - token.length) {
                const idx = hay.indexOf(token, start);
                if (idx === -1) break;
                const end = idx + token.length;
                const overlaps = taken.some(([s, e]) => !(end <= s || idx >= e));
                if (!overlaps) {
                    taken.push([idx, end]);
                    found = true;
                    break;
                }
                start = idx + 1;
            }
            if (!found) return false;
        }
        return true;
    }

    private getValidFilterValues(units: Unit[], conf: AdvFilterConfig): number[] {
        let vals = units.map(u => (u as any)[conf.key]).filter(v => typeof v === 'number');
        if (conf.ignoreValues && conf.ignoreValues.length > 0) {
            vals = vals.filter(v => !conf.ignoreValues!.includes(v));
        }
        return vals;
    }

    private loadFiltersFromUrlOnStartup() {
        effect(() => {
            const isDataReady = this.dataService.isDataReady();
            if (isDataReady && !this.urlStateInitialized) {
                const params = this.route.snapshot.queryParamMap;
                
                const expandedParam = params.get('expanded');
                if (expandedParam === 'true') {
                    this.expandedView.set(true);
                }

                // Load search query
                const searchParam = params.get('q');
                if (searchParam) {
                    this.search.set(decodeURIComponent(searchParam));
                }
                
                // Load sort settings
                const sortParam = params.get('sort');
                if (sortParam && SORT_OPTIONS.some(opt => opt.key === sortParam)) {
                    this.selectedSort.set(sortParam);
                }
                
                const sortDirParam = params.get('sortDir');
                if (sortDirParam === 'desc' || sortDirParam === 'asc') {
                    this.selectedSortDirection.set(sortDirParam);
                }
                
                // Load filters
                const filtersParam = params.get('filters');
                if (filtersParam) {
                    try {
                        const decodedFilters = decodeURIComponent(filtersParam);
                        const parsedFilters = this.parseCompactFiltersFromUrl(decodedFilters);
                        const validFilters: FilterState = {};
                        
                        for (const [key, state] of Object.entries(parsedFilters)) {
                            const conf = ADVANCED_FILTERS.find(f => f.key === key);
                            if (!conf) continue; // Skip unknown filter keys
                            
                            if (conf.type === AdvFilterType.DROPDOWN) {
                                // Get all available values for this dropdown
                                const availableValues = this.getAvailableDropdownValues(conf);
                                
                                if (conf.multistate) {
                                    const selection = state.value as MultiStateSelection;
                                    const validSelection: MultiStateSelection = {};
                                    
                                    for (const [name, selectionValue] of Object.entries(selection)) {
                                        if (availableValues.has(name)) {
                                            validSelection[name] = selectionValue;
                                        }
                                    }
                                    
                                    if (Object.keys(validSelection).length > 0) {
                                        validFilters[key] = { value: validSelection, interactedWith: true };
                                    }
                                } else {
                                    const values = state.value as string[];
                                    const validValues = values.filter(v => availableValues.has(v));
                                    
                                    if (validValues.length > 0) {
                                        validFilters[key] = { value: validValues, interactedWith: true };
                                    }
                                }
                            } else {
                                // For range filters, just keep them as-is
                                // They'll be clamped automatically by advOptions
                                validFilters[key] = state;
                            }
                        }
                        this.filterState.set(validFilters);
                    } catch (error) {
                        console.warn('Failed to parse filters from URL:', error);
                    }
                }

                if (params.has('gunnery')) {
                    const gunneryParam = params.get('gunnery');
                    if (gunneryParam) {
                        const gunnery = parseInt(gunneryParam);
                        if (!isNaN(gunnery) && gunnery >= 0 && gunnery <= 8) {
                            this.pilotGunnerySkill.set(gunnery);
                        }
                    }
                }
                
                if (params.has('piloting')) {
                    const pilotingParam = params.get('piloting');
                    if (pilotingParam) {
                        const piloting = parseInt(pilotingParam);
                        if (!isNaN(piloting) && piloting >= 0 && piloting <= 8) {
                            this.pilotPilotingSkill.set(piloting);
                        }
                    }
                }

                this.urlStateInitialized = true;
            }
        });
    }

    private getAvailableDropdownValues(conf: AdvFilterConfig): Set<string> {
        const values = new Set<string>();
        
        if (conf.external) {
            if (conf.key === 'era') {
                this.dataService.getEras().forEach(era => values.add(era.name));
            } else if (conf.key === 'faction') {
                this.dataService.getFactions().forEach(faction => values.add(faction.name));
            }
        } else {
            if (conf.key === 'componentName') {
                for (const unit of this.units) {
                    for (const component of unit.comp) {
                        values.add(component.n);
                    }
                }
            } else {
                for (const unit of this.units) {
                    const propValue = (unit as any)[conf.key];
                    if (Array.isArray(propValue)) {
                        propValue.forEach(v => { if (v != null && v !== '') values.add(v); });
                    } else if (propValue != null && propValue !== '') {
                        values.add(propValue);
                    }
                }
            }
        }
        
        return values;
    }

    private updateUrlOnFiltersChange() {
        effect(() => {
            const search = this.search();
            const filterState = this.filterState();
            const selectedSort = this.selectedSort();
            const selectedSortDirection = this.selectedSortDirection();
            const expanded = this.expandedView();
            const gunnery = this.pilotGunnerySkill();
            const piloting = this.pilotPilotingSkill();

            if (!this.urlStateInitialized) {
                return;
            }

            const currentParams = this.route.snapshot.queryParamMap;
            const queryParams: any = {};

            // Preserve existing non-filter parameters
            currentParams.keys.forEach(key => {
                if (!['q', 'sort', 'sortDir', 'filters', 'expanded', 'gunnery', 'piloting'].includes(key)) {
                    queryParams[key] = currentParams.get(key);
                }
            });
            
            // Add search query if present
            if (search.trim()) {
                queryParams.q = encodeURIComponent(search.trim());
            }
            
            // Add sort if not default
            if (selectedSort !== 'name') {
                queryParams.sort = selectedSort;
            }
            
            // Add sort direction if not default
            if (selectedSortDirection !== 'asc') {
                queryParams.sortDir = selectedSortDirection;
            }
            
            // Add filters if any are active
            const filtersParam = this.generateCompactFiltersParam(filterState);
            if (filtersParam) {
                queryParams.filters = filtersParam;
            }

            if (gunnery !== 4) {
                queryParams.gunnery = gunnery;
            }
            if (piloting !== 5) {
                queryParams.piloting = piloting;
            }

            if (expanded) {
                queryParams.expanded = 'true';
            }

            this.router.navigate([], {
                relativeTo: this.route,
                queryParams: Object.keys(queryParams).length > 0 ? queryParams : {},
                queryParamsHandling: 'replace',
                replaceUrl: true
            });
        });
    }

    private generateCompactFiltersParam(state: FilterState): string | null {
        const parts: string[] = [];
        
        for (const [key, filterState] of Object.entries(state)) {
            if (!filterState.interactedWith) continue;
            
            const conf = ADVANCED_FILTERS.find(f => f.key === key);
            if (!conf) continue;
            
            if (conf.type === AdvFilterType.RANGE) {
                const [min, max] = filterState.value;
                parts.push(`${key}:${min}-${max}`);
            } else if (conf.type === AdvFilterType.DROPDOWN) {
                if (conf.multistate) {
                    const selection = filterState.value as MultiStateSelection;
                    const subParts: string[] = [];
                    
                    for (const [name, selectionValue] of Object.entries(selection)) {
                        if (selectionValue.state !== 'off') {
                            // URL encode names that might contain spaces or special characters
                            let part = encodeURIComponent(name);
                            
                            // Use single characters for states
                            if (selectionValue.state === 'and') part += '.';
                            else if (selectionValue.state === 'not') part += '!';
                            // 'or' state is default, no suffix needed

                            
                            if (selectionValue.count > 1) {
                                part += `~${selectionValue.count}`;
                            }
                            subParts.push(part);
                        }
                    }
                    
                    if (subParts.length > 0) {
                        parts.push(`${key}:${subParts.join(',')}`);
                    }
                } else {
                    const values = filterState.value as string[];
                    if (values.length > 0) {
                        // URL encode each value to handle spaces and special characters
                        const encodedValues = values.map(v => encodeURIComponent(v));
                        parts.push(`${key}:${encodedValues.join(',')}`);
                    }
                }
            }
        }
        
        return parts.length > 0 ? parts.join('|') : null;
    }

    private parseCompactFiltersFromUrl(filtersParam: string): FilterState {
        const filterState: FilterState = {};
        
        try {
            const parts = filtersParam.split('|');
            
            for (const part of parts) {
                const colonIndex = part.indexOf(':');
                if (colonIndex === -1) continue;
                
                const key = part.substring(0, colonIndex);
                const valueStr = part.substring(colonIndex + 1);
                
                const conf = ADVANCED_FILTERS.find(f => f.key === key);
                if (!conf) continue;
                
                if (conf.type === AdvFilterType.RANGE) {
                    const dashIndex = valueStr.indexOf('-');
                    if (dashIndex !== -1) {
                        const min = parseFloat(valueStr.substring(0, dashIndex));
                        const max = parseFloat(valueStr.substring(dashIndex + 1));
                        if (!isNaN(min) && !isNaN(max)) {
                            filterState[key] = {
                                value: [min, max],
                                interactedWith: true
                            };
                        }
                    }
                } else if (conf.type === AdvFilterType.DROPDOWN) {
                    if (conf.multistate) {
                        const selection: MultiStateSelection = {};
                        const items = valueStr.split(',');
                        
                        for (const item of items) {
                            let encodedName = item;
                            let state: MultiState = 'or';
                            let count = 1;
                            
                            // Parse state suffix
                            if (item.endsWith('.')) {
                                state = 'and';
                                encodedName = item.slice(0, -1);
                            } else if (item.endsWith('!')) {
                                state = 'not';
                                encodedName = item.slice(0, -1);
                            } else {
                                state = 'or'; // default state
                            }
                            
                            // Parse count
                            const starIndex = encodedName.indexOf('~');
                            if (starIndex !== -1) {
                                count = parseInt(encodedName.substring(starIndex + 1)) || 1;
                                encodedName = encodedName.substring(0, starIndex);
                            }
                            
                            // Decode the name to restore spaces and special characters
                            const name = decodeURIComponent(encodedName);
                            selection[name] = { state, count };
                        }
                        
                        if (Object.keys(selection).length > 0) {
                            filterState[key] = {
                                value: selection,
                                interactedWith: true
                            };
                        }
                    } else {
                        // Decode each value to restore spaces and special characters
                        const values = valueStr.split(',')
                            .filter(Boolean)
                            .map(v => decodeURIComponent(v));
                        if (values.length > 0) {
                            filterState[key] = {
                                value: values,
                                interactedWith: true
                            };
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to parse compact filters from URL:', error);
        }
        
        return filterState;
    }

    setFilter(key: string, value: any) {
        const conf = ADVANCED_FILTERS.find(f => f.key === key);
        if (!conf) return;

        let interacted = true;

        if (conf.type === AdvFilterType.RANGE) {
            // For range filters, if the value matches the full available range, it's not interacted.
            const availableRange = this.advOptions()[key]?.options;
            if (availableRange && value[0] === availableRange[0] && value[1] === availableRange[1]) {
                interacted = false;
            }
        } else if (conf.type === AdvFilterType.DROPDOWN) {
            if (conf.multistate) {
                // For multistate dropdowns, check if all states are 'off' or object is empty
                if (!value || typeof value !== 'object' || Object.keys(value).length === 0 ||
                    Object.values(value).every((selectionValue: any) => selectionValue.state === 'off')) {
                    interacted = false;
                }
            } else {
                // For regular dropdowns, if the value is an empty array, it's not interacted.
                if (Array.isArray(value) && value.length === 0) {
                    interacted = false;
                }
            }
        }

        this.filterState.update(current => ({
            ...current,
            [key]: { value, interactedWith: interacted }
        }));
    }

    // Override search setter to handle URL updates
    setSearch(query: string) {
        this.search.set(query);
    }

    clearFilters() {
        this.search.set('');
        this.filterState.set({});
        this.selectedSort.set('name');
        this.selectedSortDirection.set('asc');
        this.pilotGunnerySkill.set(4);
        this.pilotPilotingSkill.set(5);
    }

    // Collect all unique tags from all units
    getAllTags(): string[] {
        const allUnits = this.dataService.getUnits();
        const existingTags = new Set<string>();
        
        for (const u of allUnits) {
            if (u._tags) {
                u._tags.forEach(tag => existingTags.add(tag));
            }
        }
        // Convert to sorted array
        return Array.from(existingTags).sort((a, b) => 
            a.toLowerCase().localeCompare(b.toLowerCase())
        );
    }

    public invalidateTagsCache(): void {
        // Update cache key to trigger recomputation of advOptions
        this.tagsCacheKey.set(Date.now().toString());
        
        // Clear any cached tag-related data
        for (const [key] of this.availableNamesCache) {
            if (key.includes('_tags')) {
                this.availableNamesCache.delete(key);
            }
        }
    }

    public async saveTagsToStorage(): Promise<void> {
        await this.dataService.saveUnitTags(this.dataService.getUnits());
    }
   
    setPilotSkills(gunnery: number, piloting: number) {
        this.pilotGunnerySkill.set(gunnery);
        this.pilotPilotingSkill.set(piloting);
    }

    getAdjustedBV(unit: Unit): number {
        const gunnery = this.pilotGunnerySkill();
        const piloting = this.pilotPilotingSkill();
        
        // Use default skills - no adjustment needed
        if (gunnery === 4 && piloting === 5) {
            return unit.bv;
        }
        
        return BVCalculatorUtil.calculateAdjustedBV(unit.bv, gunnery, piloting);
    }
}