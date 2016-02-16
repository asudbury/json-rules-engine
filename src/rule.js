'use strict'

import params from 'params'
import Condition from './condition'

let debug = require('debug')('json-rules-engine')

class Rule {
  /**
   * returns a new Rule instance
   * @param {object,string} options, or json string that can be parsed into options
   * @param {integer} options.priority (>1) - higher runs sooner.
   * @param {Object} options.event - event to fire when rule evaluates as successful
   * @param {string} options.event.type - name of event to emit
   * @param {string} options.event.params - parameters to pass to the event listener
   * @param {Object} options.conditions - conditions to evaluate when processing this rule
   * @return {Rule} instance
   */
  constructor (options) {
    if (typeof options === 'string') {
      options = JSON.parse(options)
    }
    if (options && options.conditions) {
      this.setConditions(options.conditions)
    }

    let priority = (options && options.priority) || 1
    this.setPriority(priority)

    let event = (options && options.event) || { type: 'unknown' }
    this.setEvent(event)
  }

  /**
   * Sets the priority of the rule
   * @param {integer} priority (>=1) - increasing the priority causes the rule to be run prior to other rules
   */
  setPriority (priority) {
    priority = parseInt(priority, 10)
    if (priority <= 0) throw new Error('Priority must be greater than zero')
    this.priority = priority
    return this
  }

  /**
   * Sets the conditions to run when evaluating the rule.
   * @param {object} conditions - conditions, root element must be a boolean operator
   */
  setConditions (conditions) {
    if (!conditions.hasOwnProperty('all') && !conditions.hasOwnProperty('any')) {
      throw new Error('"conditions" root must contain a single instance of "all" or "any"')
    }
    this.conditions = new Condition(conditions)
    return this
  }

  /**
   * Sets the event to emit when the conditions evaluate truthy
   * @param {object} event - event to emit
   * @param {string} event.type - event name to emit on
   * @param {string} event.params - parameters to emit as the argument of the event emission
   */
  setEvent (event) {
    this.event = params(event).only(['type', 'params'])
    return this
  }

  /**
   * Sets the engine to run the rules under
   * @param {object} engine
   * @returns {Rule}
   */
  setEngine (engine) {
    this.engine = engine
    return this
  }

  /**
   * Evaluates the rule conditions
   * @param  {Condition} condition - condition to evaluate
   * @return {Promise(true|false)} - resolves with the result of the condition evaluation
   */
  async evaluateCondition (condition) {
    let comparisonValue
    if (condition.isBooleanOperator()) {
      let subConditions = condition[condition.operator]
      comparisonValue = await this[condition.operator](subConditions)
    } else {
      comparisonValue = await this.engine.factValue(condition.fact, condition.params)
    }

    let conditionResult = condition.evaluate(comparisonValue)
    if (!condition.isBooleanOperator()) {
      debug(`evaluateConditions:: <${comparisonValue} ${condition.operator} ${condition.value}?> (${conditionResult})`)
    }
    return conditionResult
  }

  /**
   * Priorizes an array of conditions based on "priority"
   *   When no explicit priority is provided on the condition itself, the condition's priority is determine by its fact
   * @param  {Condition[]} conditions
   * @return {Condition[][]} prioritized two-dimensional array of conditions
   *    Each outer array element represents a single priority(integer).  Inner array is
   *    all conditions with that priority.
   */
  prioritizeConditions (conditions) {
    let factSets = conditions.reduce((sets, condition) => {
      // if a priority has been set on this specific condition, honor that first
      // otherwise, use the fact's priority
      let priority = condition.priority
      if (!priority) {
        let fact = this.engine.getFact(condition.fact)
        if (!fact) {
          throw new Error(`Undefined fact: ${condition.fact}`)
        }
        priority = fact.priority
      }
      if (!sets[priority]) sets[priority] = []
      sets[priority].push(condition)
      return sets
    }, {})
    return Object.keys(factSets).sort((a, b) => {
      return Number(a) > Number(b) ? -1 : 1 // order highest priority -> lowest
    }).map((priority) => factSets[priority])
  }

  /**
   * Evalutes an array of conditions, using an 'every' or 'some' array operation
   * @param  {Condition[]} conditions
   * @param  {string(every|some)} array method to call for determining result
   * @return {Promise(boolean)} whether conditions evaluated truthy or falsey based on condition evaluation + method
   */
  async evaluateConditions (conditions, method) {
    if (!(Array.isArray(conditions))) conditions = [ conditions ]
    let conditionResults = await Promise.all(conditions.map((condition) => {
      return this.evaluateCondition(condition)
    }))
    debug(`evaluateConditions::results`, conditionResults)
    return method.call(conditionResults, (result) => result === true)
  }

  /**
   * Evaluates a set of conditions based on an 'all' or 'any' operator.
   *   First, orders the top level conditions based on priority
   *   Iterates over each priority set, evaluating each condition
   *   If any condition results in the rule to be guaranteed truthy or falsey,
   *   it will short-circuit and not bother evaluating any additional rules
   * @param  {Condition[]} conditions - conditions to be evaluated
   * @param  {string('all'|'any')} operator
   * @return {Promise(boolean)} rule evaluation result
   */
  async prioritizeAndRun (conditions, operator) {
    let method = Array.prototype.some
    if (operator === 'all') {
      method = Array.prototype.every
    }
    let orderedSets = this.prioritizeConditions(conditions)
    let cursor = Promise.resolve()
    orderedSets.forEach((set) => {
      let stop = false
      cursor = cursor.then((setResult) => {
        // after the first set succeeds, don't fire off the remaining promises
        if ((operator === 'any' && setResult === true) || stop) {
          debug(`prioritizeAndRun::detected truthy result; skipping remaining conditions`)
          stop = true
          return true
        }

        // after the first set fails, don't fire off the remaining promises
        if ((operator === 'all' && setResult === false) || stop) {
          debug(`prioritizeAndRun::detected falsey result; skipping remaining conditions`)
          stop = true
          return false
        }
        // all conditions passed; proceed with running next set in parallel
        return this.evaluateConditions(set, method)
      })
    })
    return cursor
  }

  /**
   * Runs an 'any' boolean operator on an array of conditions
   * @param  {Condition[]} conditions to be evaluated
   * @return {Promise(boolean)} condition evaluation result
   */
  async any (conditions) {
    return this.prioritizeAndRun(conditions, 'any')
  }

  /**
   * Runs an 'all' boolean operator on an array of conditions
   * @param  {Condition[]} conditions to be evaluated
   * @return {Promise(boolean)} condition evaluation result
   */
  async all (conditions) {
    return this.prioritizeAndRun(conditions, 'all')
  }

  /**
   * Evaluates the rule, starting with the root boolean operator and recursing down
   * @return {Promise(boolean)} rule evaluation result
   */
  async evaluate () {
    if (this.conditions.any) {
      return await this.any(this.conditions.any)
    } else {
      return await this.all(this.conditions.all)
    }
  }
}

export default Rule
