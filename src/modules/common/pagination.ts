import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export function paginationArgs({ page, limit }: PaginationQueryDto) {
  return { skip: (page - 1) * limit, take: limit };
}

export function paginated<T>(
  data: T[],
  totalItems: number,
  query: PaginationQueryDto,
  path: string,
  filters: Record<string, unknown> = {},
  sortBy: [string, 'ASC' | 'DESC'][] = [],
) {
  const totalPages = Math.ceil(totalItems / query.limit);
  const link = (page: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({
      ...filters,
      page,
      limit: query.limit,
    })) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return `${path}?${params}`;
  };
  return {
    data,
    meta: {
      itemsPerPage: query.limit,
      totalItems,
      currentPage: query.page,
      totalPages,
      sortBy,
    },
    links: {
      current: link(query.page),
      next: query.page < totalPages ? link(query.page + 1) : '',
      last: link(Math.max(totalPages, 1)),
    },
  };
}
