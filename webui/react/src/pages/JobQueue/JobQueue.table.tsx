import { Tooltip } from 'antd';
import React, { ReactNode } from 'react';

import Badge, { BadgeType } from 'components/Badge';
import { ColumnDef } from 'components/InteractiveTable';
import Link from 'components/Link';
import { relativeTimeRenderer } from 'components/Table';
import Avatar from 'components/UserAvatar';
import { paths } from 'routes/utils';
import { getJupyterLabs, getTensorBoards } from 'services/api';
import Icon from 'shared/components/Icon/Icon';
import { floatToPercent, truncate } from 'shared/utils/string';
import { Job, JobType } from 'types';
import { jobTypeIconName, jobTypeLabel } from 'utils/job';
import { openCommand } from 'utils/wait';

import css from './JobQueue.module.scss';
import { DEFAULT_COLUMN_WIDTHS } from './JobQueue.settings';

type Renderer<T> = (_: unknown, record: T) => ReactNode;
export type JobTypeRenderer = Renderer<Job>;

export const SCHEDULING_VAL_KEY = 'schedulingVal';

const routeToTask = async (taskId: string, jobType: JobType): Promise<void> => {
  let cmds = [];
  switch (jobType) {
    case JobType.TENSORBOARD:
      cmds = await getTensorBoards({});
      break;
    case JobType.NOTEBOOK:
      cmds = await getJupyterLabs({});
      break;
    default:
      throw new Error(`Unsupported job type: ${jobType}`);
  }

  const task = cmds.find((t) => t.id === taskId);
  if (task) {
    openCommand(task);
  } else {
    throw new Error(`${jobType} ${taskId} not found`);
  }
};

const linkToEntityPage = (job: Job, label: ReactNode): ReactNode => {
  switch (job.type) {
    case JobType.EXPERIMENT:
      return <Link path={paths.experimentDetails(job.entityId)}>{label}</Link>;
    case JobType.NOTEBOOK:
    case JobType.TENSORBOARD:
      return (
        <Link onClick={() => {
          routeToTask(job.entityId, job.type);
        }}>{label}
        </Link>
      );
    default:
      return label;
  }
};

export const columns: ColumnDef<Job>[] = [
  {
    dataIndex: 'preemptible',
    defaultWidth: DEFAULT_COLUMN_WIDTHS['preemptible'],
    key: 'jobsAhead',
  },
  // { // We might want to show the entityId here instead.
  //   dataIndex: 'jobId',
  //   key: 'jobId',
  //   render: (_: unknown, record: Job): ReactNode => {
  //     const label = truncate(record.jobId, 6, '');
  //     return linkToEntityPage(record, label);
  //   },
  //   title: 'ID',
  // },
  {
    dataIndex: 'type',
    defaultWidth: DEFAULT_COLUMN_WIDTHS['type'],
    key: 'type',
    render: (_: unknown, record: Job): ReactNode => {
      const title = jobTypeLabel(record.type);
      const TypeCell = (
        <Tooltip placement="topLeft" title={title}>
          <div>
            <Icon name={jobTypeIconName(record.type)} />
          </div>
        </Tooltip>
      );
      return TypeCell;
    },
    title: 'Type',
  },
  {
    dataIndex: 'name',
    defaultWidth: DEFAULT_COLUMN_WIDTHS['name'],
    key: 'name',
    render: (_: unknown, record: Job): ReactNode => {
      let label: ReactNode = null;
      switch (record.type) {
        case JobType.EXPERIMENT:
          label = (
            <div>{record.name}
              <Tooltip title="Experiment ID">
                {` (${record.entityId})`}
              </Tooltip>
            </div>
          );
          break;
        default:
          label = <span>{jobTypeLabel(record.type)} {truncate(record.entityId, 6, '')}</span>;
          break;
      }

      return linkToEntityPage(record, label);
    },
    title: 'Job Name',
  },
  {
    dataIndex: 'priority',
    defaultWidth: DEFAULT_COLUMN_WIDTHS['priority'],
    key: SCHEDULING_VAL_KEY,
    title: 'Priority',
  },
  {
    dataIndex: 'submissionTime',
    defaultWidth: DEFAULT_COLUMN_WIDTHS['submissionTime'],
    key: 'submitted',
    render: (_: unknown, record: Job): ReactNode =>
      record.submissionTime && relativeTimeRenderer(record.submissionTime),
    title: 'Submitted',
  },
  {
    dataIndex: 'slots',
    defaultWidth: DEFAULT_COLUMN_WIDTHS['slots'],
    key: 'slots',
    render: (_: unknown, record: Job): ReactNode => {
      const cell = (
        <span>
          <Tooltip title="Allocated (scheduled) slots">{record.allocatedSlots}</Tooltip>
          {' / '}
          <Tooltip title="Requested (queued) slots">{record.requestedSlots}</Tooltip>
        </span>
      );
      return cell;
    },
    title: 'Slots',
  },
  {
    dataIndex: 'status',
    defaultWidth: DEFAULT_COLUMN_WIDTHS['status'],
    key: 'state',
    render: (_: unknown, record: Job): ReactNode => {
      return (
        <div className={css.state}>
          <Badge state={record.summary.state} type={BadgeType.State} />
          {(!!record?.progress) && <span> {floatToPercent(record.progress, 1)}</span>}
        </div>
      );
    },
    title: 'Status',
  },
  {
    dataIndex: 'user',
    defaultWidth: DEFAULT_COLUMN_WIDTHS['user'],
    key: 'user',
    render: (_: unknown, record: Job): ReactNode => {
      const cell = <Avatar userId={record.userId} />;
      return cell;
    },
    title: 'User',
  },
  {
    align: 'right',
    className: 'fullCell',
    dataIndex: 'action',
    defaultWidth: DEFAULT_COLUMN_WIDTHS['action'],
    fixed: 'right',
    key: 'actions',
    title: '',
  },
];
