import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';

/** regions.level */
export const REGION_LEVELS = ['city', 'outside'] as const;
export type RegionLevel = (typeof REGION_LEVELS)[number];

@Entity({ name: 'regions' })
export class Region {
  @PrimaryColumn({ name: 'code', type: 'varchar', length: 32 })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 64, nullable: false })
  name: string;

  @Column({
    name: 'level',
    type: 'enum',
    enum: [...REGION_LEVELS],
    default: 'city',
  })
  level: RegionLevel;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Entity({ name: 'industries' })
export class Industry {
  @PrimaryColumn({ name: 'code', type: 'varchar', length: 32 })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 64, nullable: false })
  name: string;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}
