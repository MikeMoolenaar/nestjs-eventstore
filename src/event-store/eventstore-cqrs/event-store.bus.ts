import { IEvent } from '@nestjs/cqrs';
import { Subject } from 'rxjs';
import {
  EventData,
  createEventData,
  EventStorePersistentSubscription,
  ResolvedEvent,
  EventStoreCatchUpSubscription, StreamEventsSlice, RecordedEvent
} from "node-eventstore-client";
import { v4 } from 'uuid';
import { Logger } from '@nestjs/common';
import { EventStore } from '../event-store.class';
import {
  EventStoreBusConfig,
  EventStoreSubscriptionType,
  EventStorePersistentSubscription as ESPersistentSubscription,
  EventStoreCatchupSubscription as ESCatchUpSubscription,
} from './event-bus.provider';
import { IEventMetaData } from '../shared/event.interface';

interface ExtendedCatchUpSubscription extends EventStoreCatchUpSubscription {
  isLive: boolean | undefined;
}

interface ExtendedPersistentSubscription
  extends EventStorePersistentSubscription {
  isLive: boolean | undefined;
}

export class EventStoreBus {
  private logger = new Logger('EventStoreBus');
  private catchupSubscriptions: ExtendedCatchUpSubscription[] = [];
  private catchupSubscriptionsCount: number;

  private persistentSubscriptions: ExtendedPersistentSubscription[] = [];
  private persistentSubscriptionsCount: number;

  constructor(
    private eventStore: EventStore,
    private subject$: Subject<{ event: IEvent, eventMetaData: IEventMetaData }>,
    private subscriptionEventNames: string[],
    config: EventStoreBusConfig,
  ) {

    const catchupSubscriptions = config.subscriptions.filter((sub) => {
      return sub.type === EventStoreSubscriptionType.CatchUp;
    });

    const persistentSubscriptions = config.subscriptions.filter((sub) => {
      return sub.type === EventStoreSubscriptionType.Persistent;
    });

    this.subscribeToCatchUpSubscriptions(
      catchupSubscriptions as ESCatchUpSubscription[],
    );

    this.subscribeToPersistentSubscriptions(
      persistentSubscriptions as ESPersistentSubscription[],
    );
  }

  async subscribeToPersistentSubscriptions(
    subscriptions: ESPersistentSubscription[],
  ) {
    this.persistentSubscriptionsCount = subscriptions.length;
    this.persistentSubscriptions = await Promise.all(
      subscriptions.map(async (subscription) => {
        return await this.subscribeToPersistentSubscription(
          subscription.stream,
          subscription.persistentSubscriptionName,
        );
      }),
    );
  }

  subscribeToCatchUpSubscriptions(subscriptions: ESCatchUpSubscription[]) {
    this.catchupSubscriptionsCount = subscriptions.length;
    this.catchupSubscriptions = subscriptions.map((subscription) => {
      return this.subscribeToCatchupSubscription(subscription.stream);
    });
  }

  get allCatchUpSubscriptionsLive(): boolean {
    const initialized =
      this.catchupSubscriptions.length === this.catchupSubscriptionsCount;
    return (
      initialized &&
      this.catchupSubscriptions.every((subscription) => {
        return !!subscription && subscription.isLive;
      })
    );
  }

  get allPersistentSubscriptionsLive(): boolean {
    const initialized =
      this.persistentSubscriptions.length === this.persistentSubscriptionsCount;
    return (
      initialized &&
      this.persistentSubscriptions.every((subscription) => {
        return !!subscription && subscription.isLive;
      })
    );
  }

  get isLive(): boolean {
    return (
      this.allCatchUpSubscriptionsLive && this.allPersistentSubscriptionsLive
    );
  }

  async publish(event: IEvent, stream?: string) {
    const payload: EventData = createEventData(
      v4(),
      event.constructor.name,
      true,
      Buffer.from(JSON.stringify(event)),
    );

    try {
      await this.eventStore.connection.appendToStream(stream, -2, [payload]);
    } catch (err) {
      this.logger.error(err.message, err.stack);
    }
  }

  async publishAll(events: IEvent[], stream?: string) {
    try {
      await this.eventStore.connection.appendToStream(stream, -2, (events || []).map(
        (event: IEvent) => createEventData(
          v4(),
          event.constructor.name,
          true,
          Buffer.from(JSON.stringify(event)),
        ),
      ));
    } catch (err) {
      this.logger.error(err);
    }
  }

  async getStreamLength(stream: string): Promise<number> {
    const event = await this.eventStore.connection.readStreamEventsBackward(stream, -1, 1, false);
    return event.lastEventNumber.low;
  }

  async getEventsForward(stream: string, start: number = 0, count: number = null): Promise<StreamEventsSlice> {
    return await this.eventStore.connection.readStreamEventsForward(stream, start, count ?? await this.getStreamLength(stream), true);
  }

  async replayEventsForward(stream: string, start: number = 0, count: number = null): Promise<void> {
    const events = await this.getEventsForward(stream, start, count);
    for (const event of events.events) {
      this.onEvent(null, event);
    }
  }

  async getEventsBackward(stream: string, start: number = -1, count: number = null): Promise<StreamEventsSlice> {
    return await this.eventStore.connection.readStreamEventsBackward(stream, start, count ?? await this.getStreamLength(stream), true);
  }

  async replayEventsBackward(stream: string, start: number = -1, count: number = null): Promise<void> {
    const events = await this.getEventsBackward(stream, start, count);
    for (const event of events.events) {
      this.onEvent(null, event);
    }
  }

  async getEvents(stream: string): Promise<any[]> {
    return (await this.getEventsForward(stream)).events.map((resolvedEvent) => {
      const obj = JSON.parse(resolvedEvent.event.data.toString());
      return EventStoreBus.setConstructorName(obj, resolvedEvent.event.eventType);
    });
  }

  static setConstructorName(payload: any, type: string): any {
    payload.constructor = { name: type };
    return Object.assign(Object.create(payload), payload);
  }

  subscribeToCatchupSubscription(stream: string): ExtendedCatchUpSubscription {
    this.logger.log(`Catching up and subscribing to stream ${stream}!`);
    try {
      return this.eventStore.connection.subscribeToStreamFrom(
        stream,
        0,
        true,
        (sub, payload) => this.onEvent(sub, payload),
        subscription =>
          this.onLiveProcessingStarted(
            subscription as ExtendedCatchUpSubscription,
          ),
        (sub, reason, error) =>
          this.onDropped(sub as ExtendedCatchUpSubscription, reason, error),
      ) as ExtendedCatchUpSubscription;
    } catch (err) {
      this.logger.error(err.message, err.stack);
    }
  }

  async subscribeToPersistentSubscription(
    stream: string,
    subscriptionName: string,
  ): Promise<ExtendedPersistentSubscription> {
    try {
      this.logger.log(`
      Connecting to persistent subscription ${subscriptionName} on stream ${stream}!
      `);
      const resolved = (await this.eventStore.connection.connectToPersistentSubscription(
        stream,
        subscriptionName,
        (sub, payload) => this.onEvent(sub, payload),
        (sub, reason, error) =>
          this.onDropped(sub as ExtendedPersistentSubscription, reason, error),
      )) as ExtendedPersistentSubscription;

      resolved.isLive = true;

      return resolved;
    } catch (err) {
      this.logger.error(err.message, err.stack);
    }
  }

  async onEvent(
    _subscription:
      | EventStorePersistentSubscription
      | EventStoreCatchUpSubscription,
    payload: ResolvedEvent,
  ) {
    const { event } = payload;
    if ((payload.link !== null && !payload.isResolved) || !event || !event.isJson) {
      this.logger.error('Received event that could not be resolved!');
      return;
    }

    if (!this.subscriptionEventNames.some(name => name === event.eventType)) {
      this.logger.error(`Received ${event.eventType} could not be handled by any of the provided event handlers!`);
      return;
    }

    const data = JSON.parse(event.data.toString());
    const metadata = event.metadata.length > 0 ? JSON.parse(event.metadata.toString()) : null;

    const eventMetaData: IEventMetaData = {
      eventName: event.eventType,
      streamMetaData: metadata,
      eventNumber: event.eventNumber.low,
      eventId: event.eventId,
      eventStreamId: event.eventStreamId,
      dateCreated: event.created,
    };
    console.log('submitted!');
    // tslint:disable-next-line:object-shorthand-properties-first
    this.subject$.next({ event: data, eventMetaData });
  }

  onDropped(
    subscription: ExtendedPersistentSubscription | ExtendedCatchUpSubscription,
    _reason: string,
    error: Error,
  ) {
    subscription.isLive = false;
    this.logger.error(error.message, error.stack);
  }

  onLiveProcessingStarted(subscription: ExtendedCatchUpSubscription) {
    subscription.isLive = true;
    this.logger.log('Live processing of EventStore events started!');
  }
}
