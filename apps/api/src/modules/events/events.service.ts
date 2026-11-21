import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, In, Repository } from 'typeorm';
import { paginate } from '../../common/dto/pagination.dto';
import type { PageResult } from '../../common/dto/pagination.dto';
import { isDuplicateKeyError } from '../../common/utils/duplicate-key';
import { Event, EventRegistration } from '../../database/entities/event.entity';
import { User } from '../../database/entities/user.entity';
import { NotificationService } from '../notifications/notification.service';
import { CreateEventBodyDto, UpdateEventBodyDto } from './dto/event.dto';

export interface EventView {
  id: number;
  title: string;
  kind: string;
  regionCode: string | null;
  regionName: string | null;
  place: string | null;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  capacity: number;
  registeredCount: number;
  status: string;
  coverMediaId: number | null;
  myRegistration: string | null;
  createdAt: Date;
}

/** 管理端报名名单的一行（契约 `EventRegistrationDto`） */
export interface EventRegistrationView {
  id: number;
  eventId: number;
  userId: number;
  userName: string;
  status: string;
  note: string | null;
  createdAt: Date;
}

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRegistration)
    private readonly registrations: Repository<EventRegistration>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
  ) {}

  async list(params: {
    page: number;
    pageSize: number;
    status?: string;
    regionCode?: string;
  }): Promise<PageResult<EventView>> {
    const qb = this.events
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.region', 'region')
      .orderBy('event.startsAt', 'DESC')
      .addOrderBy('event.id', 'DESC');

    qb.andWhere('event.status = :status', { status: params.status ?? 'published' });
    if (params.regionCode) {
      qb.andWhere('event.regionCode = :regionCode', { regionCode: params.regionCode });
    }
    qb.skip((params.page - 1) * params.pageSize).take(params.pageSize);

    const [entities, total] = await qb.getManyAndCount();
    return paginate(
      entities.map((event) => this.toView(event)),
      total,
      params.page,
      params.pageSize,
    );
  }

  async detail(id: number, viewerId?: number): Promise<EventView> {
    const event = await this.events.findOne({ where: { id }, relations: { region: true } });
    if (!event) throw new NotFoundException('活动不存在');
    const view = this.toView(event);
    if (viewerId) {
      const registration = await this.registrations.findOne({
        where: { eventId: id, userId: viewerId },
      });
      view.myRegistration = registration?.status ?? null;
    }
    return view;
  }

  /**
   * 报名：单条条件更新完成「检查容量 + 占用名额」，避免读改写竞态；
   * 唯一索引 uk_event_registration 保证同一活动只有一条报名记录。
   */
  async register(eventId: number, userId: number, note?: string) {
    const result = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(EventRegistration, {
        where: { eventId, userId },
      });
      if (existing && existing.status === 'registered') {
        return { idempotent: true, registration: existing, event: null };
      }

      const updateResult = await manager
        .createQueryBuilder()
        .update(Event)
        .set({ registeredCount: () => 'registered_count + 1' })
        .where('id = :eventId', { eventId })
        .andWhere('status = :published', { published: 'published' })
        .andWhere('(capacity = 0 OR registered_count < capacity)')
        .execute();

      if (!updateResult.affected) {
        const event = await manager.findOne(Event, { where: { id: eventId } });
        if (!event) throw new NotFoundException('活动不存在');
        if (event.status !== 'published') throw new ConflictException('活动当前不可报名');
        throw new ConflictException('活动名额已满');
      }

      if (existing) {
        existing.status = 'registered';
        existing.note = note ?? existing.note;
        const saved = await manager.save(existing);
        await this.notifyRegistered(manager, eventId, userId, saved.id);
        return { idempotent: false, registration: saved, event: null };
      }

      try {
        const registration = await manager.save(
          manager.create(EventRegistration, {
            eventId,
            userId,
            status: 'registered',
            note: note ?? null,
          }),
        );
        await this.notifyRegistered(manager, eventId, userId, registration.id);
        return { idempotent: false, registration, event: null };
      } catch (error) {
        // ⚠️ `event_registrations` 有唯一索引 `uk_event_registration (event_id, user_id)`：
        //   并发报名（同一用户同一活动）时两个请求都会「没找到报名记录」→ 都去 INSERT →
        //   后到的撞唯一键。这个撞键是**业务冲突**，必须落到 409，
        //   绝不能冒泡成 500（那会被客户端当成「服务端故障」）。
        if (isDuplicateKeyError(error)) {
          throw new ConflictException('报名信息冲突，请重试');
        }
        throw error;
      }
    });

    const event = await this.events.findOne({ where: { id: eventId } });
    return {
      registrationId: result.registration.id,
      status: result.registration.status,
      idempotent: result.idempotent,
      registeredCount: event?.registeredCount ?? 0,
      capacity: event?.capacity ?? 0,
    };
  }

  /**
   * 报名成功通知。**必须与报名写入同事务**（缺陷 #99）：
   * 否则报名已提交而通知写失败 → 用户报名成功却永远收不到通知。
   */
  private async notifyRegistered(
    manager: EntityManager,
    eventId: number,
    userId: number,
    registrationId: number,
  ): Promise<void> {
    const event = await manager.findOne(Event, { where: { id: eventId } });
    if (!event) return;
    await this.notifications.push(
      userId,
      'event_registration',
      '报名成功',
      `你已成功报名「${event.title}」`,
      { eventId, registrationId },
      { eventType: 'event.registration.created', aggregateType: 'event', aggregateId: String(eventId) },
      manager,
    );
  }

  /** 取消报名：软取消并回收名额（条件更新保证计数不为负）。 */
  async cancel(eventId: number, userId: number) {
    const registration = await this.registrations.findOne({ where: { eventId, userId } });
    if (!registration) throw new NotFoundException('报名记录不存在');
    if (registration.status === 'cancelled') {
      return { cancelled: true, idempotent: true };
    }
    const outcome = await this.dataSource.transaction(async (manager) => {
      // ⚠️ 必须检查影响行数（缺陷 #122）：
      //   上面那次读取发生在**事务之外**，到这一步时这条报名可能**已经被别人取消**
      //   （并发取消，或状态被别人改成 'attended'）。
      //   此时条件更新影响 0 行 —— 说明**这次取消没有真正生效**，
      //   若仍继续回收名额，名额就会被**凭空多出来一个**
      //   （容量判定失真 → 看起来还有名额，实际会超卖）。
      const updated = await manager
        .createQueryBuilder()
        .update(EventRegistration)
        .set({ status: 'cancelled' })
        .where('id = :id', { id: registration.id })
        .andWhere('status = :registered', { registered: 'registered' })
        .execute();
      if (!updated.affected) {
        // 读一下当前状态，给出**如实**的返回值：
        // 已经是「已取消」→ cancelled=true（本次是幂等命中）；
        // 是别的状态（如 'attended'）→ cancelled=false（这次取消确实没生效）。
        const current = await manager.findOne(EventRegistration, {
          where: { id: registration.id },
        });
        return { cancelled: current?.status === 'cancelled', idempotent: true };
      }
      await manager
        .createQueryBuilder()
        .update(Event)
        .set({ registeredCount: () => 'GREATEST(registered_count - 1, 0)' })
        .where('id = :eventId', { eventId })
        .andWhere('registered_count > 0')
        .execute();
      return { cancelled: true, idempotent: false };
    });
    return { cancelled: outcome.cancelled, idempotent: outcome.idempotent };
  }

  /**
   * 我报名的活动（分页）。
   *
   * 契约 `EventDto.myRegistration` 表示「我在这场活动里的报名状态」，
   * 因此这个端点返回的是**活动列表**（每条带 myRegistration），而不是报名记录 ——
   * 小程序「我的活动」页与「我的」页都按 `PageResult<EventDto>` 消费。
   *
   * 之前这里返回的是「报名记录数组」，小程序取 `result.items` 得到 undefined →
   * 页面恒空、「我的」页计数恒 0。详见 KNOWN-ISSUES #69。
   */
  async myRegistrations(
    userId: number,
    page = 1,
    pageSize = 20,
  ): Promise<PageResult<EventView>> {
    const qb = this.registrations
      .createQueryBuilder('reg')
      .where('reg.userId = :userId', { userId })
      .orderBy('reg.id', 'DESC');
    const total = await qb.getCount();
    const rows = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();

    // 批量取活动，避免 N+1
    const eventIds = [...new Set(rows.map((row) => row.eventId))];
    const events = eventIds.length
      ? await this.events.find({ where: { id: In(eventIds) }, relations: { region: true } })
      : [];
    const eventMap = new Map(events.map((event) => [event.id, event]));

    // 活动被删除后报名记录可能残留 → 过滤掉取不到活动的项
    const items = rows
      .map((registration) => {
        const event = eventMap.get(registration.eventId);
        if (!event) return null;
        const view = this.toView(event);
        view.myRegistration = registration.status;
        return view;
      })
      .filter((view): view is EventView => view !== null);
    return paginate(items, total, page, pageSize);
  }

  /**
   * 管理端：活动报名名单（**分页**）。
   *
   * ⚠️ 第三轮：此前一次性返回该活动的**全部**报名记录（裸数组、无上限）——
   *    一个 1000 人活动的点名 = 1000 行全量返回，浏览器与服务端都吃不消。
   *    现在按 `page/pageSize` 分页，与其它列表接口口径统一（`{items, meta}`）。
   *
   * 计数与取数分两条 SQL：先 COUNT 拿总数，再取当页 —— 不做「取全量再切片」。
   */
  async registrationRoster(
    eventId: number,
    page = 1,
    pageSize = 20,
  ): Promise<PageResult<EventRegistrationView>> {
    const qb = this.registrations
      .createQueryBuilder('registration')
      .where('registration.eventId = :eventId', { eventId })
      .orderBy('registration.id', 'ASC');
    const total = await qb.getCount();
    const rows = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();
    const userIds = rows.map((row) => row.userId);
    const users = userIds.length ? await this.users.find({ where: userIds.map((id) => ({ id })) }) : [];
    const nameMap = new Map(users.map((user) => [user.id, user.nickname]));
    const items = rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      userId: row.userId,
      userName: nameMap.get(row.userId) ?? '校友',
      status: row.status,
      note: row.note,
      createdAt: row.createdAt,
    }));
    return paginate(items, total, page, pageSize);
  }

  async adminList(params: {
    page: number;
    pageSize: number;
    status?: string;
  }): Promise<PageResult<EventView>> {
    return this.list({ ...params, status: params.status ?? 'published' });
  }

  async adminAll(params: {
    page: number;
    pageSize: number;
    keyword?: string;
    status?: string;
  }): Promise<PageResult<EventView>> {
    const qb = this.events
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.region', 'region')
      .orderBy('event.id', 'DESC');
    // 关键字与状态筛选：后台「活动管理」页的搜索框 / 状态下拉必须真正生效
    // 详见 KNOWN-ISSUES #63
    if (params.keyword?.trim()) {
      const keyword = `%${params.keyword.trim()}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .orWhere('event.title LIKE :keyword', { keyword })
            .orWhere('event.description LIKE :keyword', { keyword })
            .orWhere('event.kind LIKE :keyword', { keyword });
        }),
      );
    }
    if (params.status) {
      qb.andWhere('event.status = :status', { status: params.status });
    }
    qb.skip((params.page - 1) * params.pageSize)
      .take(params.pageSize);
    const [entities, total] = await qb.getManyAndCount();
    return paginate(
      entities.map((event) => this.toView(event)),
      total,
      params.page,
      params.pageSize,
    );
  }

  /**
   * 管理端创建活动。
   *
   * 请求体已由 `CreateEventBodyDto` 校验（字段类型、长度、枚举都保证过），
   * 因此这里不再做 `String()` / `Number()` 强转 ——
   * 强转只会把畸形输入悄悄变成合法值（缺陷 #79）。
   */
  async create(
    payload: CreateEventBodyDto,
    adminId: number,
    manager?: EntityManager,
  ): Promise<EventView> {
    const events = manager ? manager.getRepository(Event) : this.events;
    const event = events.create({
      title: payload.title,
      kind: payload.kind,
      regionCode: payload.regionCode ?? null,
      place: payload.place ?? null,
      description: payload.description ?? null,
      startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
      endsAt: payload.endsAt ? new Date(payload.endsAt) : null,
      capacity: payload.capacity,
      status: payload.status ?? 'published',
      coverMediaId: payload.coverMediaId ?? null,
      createdBy: adminId,
    });
    const saved = await events.save(event);
    return this.toView(saved);
  }

  /** 管理端更新活动（PATCH 语义：未传的字段保持原样） */
  async update(
    id: number,
    payload: UpdateEventBodyDto,
    manager?: EntityManager,
  ): Promise<EventView> {
    const events = manager ? manager.getRepository(Event) : this.events;
    const event = await events.findOne({ where: { id } });
    if (!event) throw new NotFoundException('活动不存在');
    if (payload.title !== undefined) event.title = payload.title;
    if (payload.kind !== undefined) event.kind = payload.kind;
    if (payload.regionCode !== undefined) event.regionCode = payload.regionCode ?? null;
    if (payload.place !== undefined) event.place = payload.place ?? null;
    if (payload.description !== undefined) event.description = payload.description ?? null;
    if (payload.startsAt !== undefined) {
      event.startsAt = payload.startsAt ? new Date(payload.startsAt) : null;
    }
    if (payload.endsAt !== undefined) {
      event.endsAt = payload.endsAt ? new Date(payload.endsAt) : null;
    }
    if (payload.capacity !== undefined) {
      // ⚠️ 容量不得改到**小于当前报名人数**（缺陷 #123）：
      //   否则活动进入「报名人数 > 容量」的不可能状态 ——
      //   已报名的人超出了上限，而后续报名又被 `registered_count < capacity` 拦住，
      //   活动永远卡在一个自相矛盾的状态里（而且没有任何地方会报这个错）。
      //   capacity = 0 表示「不限」，不参与比较。
      if (payload.capacity > 0 && payload.capacity < event.registeredCount) {
        throw new BadRequestException(
          `人数上限不能小于当前报名人数（${event.registeredCount}）`,
        );
      }
      event.capacity = payload.capacity;
    }
    if (payload.status !== undefined) event.status = payload.status;
    if (payload.coverMediaId !== undefined) event.coverMediaId = payload.coverMediaId ?? null;
    event.version += 1;
    const saved = await events.save(event);
    return this.toView(saved);
  }

  async remove(id: number, manager?: EntityManager): Promise<{ deleted: boolean }> {
    const events = manager ? manager.getRepository(Event) : this.events;
    const result = await events.delete({ id });
    if (!result.affected) throw new NotFoundException('活动不存在');
    return { deleted: true };
  }

  private toView(event: Event): EventView {
    return {
      id: event.id,
      title: event.title,
      kind: event.kind,
      regionCode: event.regionCode,
      regionName: event.region?.name ?? null,
      place: event.place,
      description: event.description,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      capacity: event.capacity,
      registeredCount: event.registeredCount,
      status: event.status,
      coverMediaId: event.coverMediaId,
      myRegistration: null,
      createdAt: event.createdAt,
    };
  }
}
