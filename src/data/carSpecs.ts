/** Specs from https://www.w-racingteam.com/racing/cars/bmw-m-hybrid-v8-7 — for Phase B overlays */

export const carSpecs = {
  name: 'BMW M Hybrid V8',
  team: 'BMW M Team WRT',
  number: 15,
  class: 'Hypercar',
  championship: 'FIA World Endurance Championship',
  drivers: ['Raffaele Marciello', 'Dries Vanthoor', 'Kevin Magnussen'],
  engine: {
    type: 'V-shaped Otto four-stroke twin-turbo engine',
    valvesPerCylinder: 4,
    maxTorque: '650 Nm',
    displacement: '3,999 cm³',
  },
  transmission: 'n/a',
  suspension:
    'Torsional suspension springs at the front and coil springs at the rear axle',
  tyres: {
    front: '18 x 12.5 inch',
    rear: '18 x 14 inch',
  },
  body: {
    structure: 'n/a',
    height: 'Approximately 1,200 mm',
    weight: '1,030 kg',
  },
} as const;

export type CarSpecs = typeof carSpecs;
